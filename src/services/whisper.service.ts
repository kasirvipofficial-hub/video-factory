import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { log } from '../utils/logger';
import { ENV } from '../config/env';

const execAsync = promisify(exec);

export interface TranscriptionSegment {
    start: number;
    end: number;
    text: string;
}

interface WhisperPreparedInput {
    audioPath: string;
    generatedFiles: string[];
    generatedDirs: string[];
}

export class WhisperService {
    private static shellQuote(value: string): string {
        return `"${value.replace(/"/g, '\\"')}"`;
    }

    private static async runFfmpeg(command: string): Promise<void> {
        await execAsync(command, {
            maxBuffer: 16 * 1024 * 1024,
            timeout: 20 * 60 * 1000
        });
    }

    private static getMaxWhisperBytes(): number {
        const mb = Math.max(1, ENV.WHISPER_MAX_FILE_MB || 20);
        return mb * 1024 * 1024;
    }

    private static async prepareAudioForWhisper(inputPath: string): Promise<WhisperPreparedInput> {
        const generatedFiles: string[] = [];
        const generatedDirs: string[] = [];

        const inputDir = path.dirname(inputPath);
        const outputPath = path.join(inputDir, `whisper_ready_${Date.now()}.mp3`);

        const ffmpegCmd =
            `${this.shellQuote(ENV.FFMPEG_PATH)} -i ${this.shellQuote(inputPath)} -vn ` +
            `-ac 1 -ar ${ENV.WHISPER_AUDIO_SAMPLE_RATE} -b:a ${ENV.WHISPER_AUDIO_BITRATE} -f mp3 -y ${this.shellQuote(outputPath)}`;

        try {
            await this.runFfmpeg(ffmpegCmd);
            generatedFiles.push(outputPath);
            return {
                audioPath: outputPath,
                generatedFiles,
                generatedDirs
            };
        } catch (err: any) {
            log.warn(
                { err: err.message, inputPath },
                'Whisper audio preparation failed, using original input'
            );
            return {
                audioPath: inputPath,
                generatedFiles,
                generatedDirs
            };
        }
    }

    private static async splitAudioIntoChunks(audioPath: string): Promise<{ chunkPaths: string[]; chunkSeconds: number; chunkDir?: string }> {
        const chunkSeconds = Math.max(60, ENV.WHISPER_CHUNK_SECONDS || 480);
        const chunkDir = path.join(path.dirname(audioPath), `whisper_chunks_${Date.now()}`);
        fs.mkdirSync(chunkDir, { recursive: true });

        const pattern = path.join(chunkDir, 'chunk_%03d.mp3');

        const ffmpegCmd =
            `${this.shellQuote(ENV.FFMPEG_PATH)} -i ${this.shellQuote(audioPath)} ` +
            `-f segment -segment_time ${chunkSeconds} -c copy -reset_timestamps 1 -y ${this.shellQuote(pattern)}`;

        try {
            await this.runFfmpeg(ffmpegCmd);
            const chunkPaths = fs
                .readdirSync(chunkDir)
                .filter((file) => file.endsWith('.mp3'))
                .sort()
                .map((file) => path.join(chunkDir, file));

            return { chunkPaths, chunkSeconds, chunkDir };
        } catch (err: any) {
            log.warn(
                { err: err.message, audioPath },
                'Whisper chunk split failed, falling back to single-file transcription'
            );
            return {
                chunkPaths: [audioPath],
                chunkSeconds
            };
        }
    }

    private static async transcribeSingleFile(filePath: string, offsetSeconds: number): Promise<TranscriptionSegment[]> {
        const audioBuffer = fs.readFileSync(filePath);
        const formData = new FormData();
        const fileName = path.basename(filePath);

        formData.append('file', new Blob([audioBuffer], { type: 'audio/mpeg' }), fileName);
        formData.append('model', 'whisper-1');
        formData.append('response_format', 'verbose_json');

        const response = await axios.post(
            `${ENV.WHISPER_API_URL}/audio/transcriptions`,
            formData,
            {
                headers: {
                    Authorization: `Bearer ${ENV.WHISPER_API_KEY}`
                },
                timeout: ENV.WHISPER_TIMEOUT_MS
            }
        );

        const segments: TranscriptionSegment[] = response.data.segments?.map((seg: any) => ({
            start: Math.floor(seg.start + offsetSeconds),
            end: Math.floor(seg.end + offsetSeconds),
            text: (seg.text || '').trim()
        })) || [];

        return segments;
    }

    private static async transcribeSingleFileWithRetry(
        filePath: string,
        offsetSeconds: number,
        chunkIndex: number,
        totalChunks: number
    ): Promise<TranscriptionSegment[]> {
        const maxAttempts = 2;
        let lastErr: any = null;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const segments = await this.transcribeSingleFile(filePath, offsetSeconds);
                log.info(
                    {
                        chunkIndex,
                        totalChunks,
                        attempt,
                        segmentCount: segments.length,
                        filePath
                    },
                    'Whisper chunk transcription complete'
                );
                return segments;
            } catch (err: any) {
                lastErr = err;
                log.warn(
                    {
                        chunkIndex,
                        totalChunks,
                        attempt,
                        maxAttempts,
                        status: err.response?.status,
                        err: err.message
                    },
                    'Whisper chunk transcription failed'
                );
            }
        }

        throw lastErr;
    }

    private static cleanupGenerated(paths: WhisperPreparedInput, chunkDir?: string): void {
        for (const filePath of paths.generatedFiles) {
            try {
                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                }
            } catch (_err) {
                // Best-effort cleanup.
            }
        }

        const dirs = [...paths.generatedDirs];
        if (chunkDir) dirs.push(chunkDir);

        for (const dirPath of dirs) {
            try {
                if (fs.existsSync(dirPath)) {
                    fs.rmSync(dirPath, { recursive: true, force: true });
                }
            } catch (_err) {
                // Best-effort cleanup.
            }
        }
    }

    /**
     * Transcribe audio/video input with robust anti-413 strategy:
     * 1) normalize to low-bitrate mono mp3
     * 2) split to chunks if still too large
     * 3) merge segments with time offsets
     */
    static async transcribe(inputPath: string): Promise<TranscriptionSegment[]> {
        log.info({ inputPath }, 'Whisper transcription starting');

        const prepared = await this.prepareAudioForWhisper(inputPath);
        const maxBytes = this.getMaxWhisperBytes();
        const sizeBytes = fs.statSync(prepared.audioPath).size;

        let chunkDir: string | undefined;

        try {
            if (sizeBytes <= maxBytes) {
                const segments = await this.transcribeSingleFileWithRetry(prepared.audioPath, 0, 1, 1);
                return segments;
            }

            log.warn(
                {
                    inputPath: prepared.audioPath,
                    sizeBytes,
                    maxBytes,
                    chunkSeconds: ENV.WHISPER_CHUNK_SECONDS
                },
                'Whisper input too large, switching to chunked transcription'
            );

            const chunking = await this.splitAudioIntoChunks(prepared.audioPath);
            chunkDir = chunking.chunkDir;

            const allSegments: TranscriptionSegment[] = [];
            for (let i = 0; i < chunking.chunkPaths.length; i++) {
                const chunkPath = chunking.chunkPaths[i];
                const offsetSeconds = i * chunking.chunkSeconds;
                const chunkSegments = await this.transcribeSingleFileWithRetry(
                    chunkPath,
                    offsetSeconds,
                    i + 1,
                    chunking.chunkPaths.length
                );
                allSegments.push(...chunkSegments);
            }

            return allSegments.sort((a, b) => a.start - b.start);
        } catch (err: any) {
            log.error({ err: err.message, status: err.response?.status }, 'Whisper transcription failed');
            throw err;
        } finally {
            this.cleanupGenerated(prepared, chunkDir);
        }
    }

    /**
     * Generate SRT subtitle file dari segments
     */
    static generateSRT(segments: TranscriptionSegment[]): string {
        return segments
            .map((seg, idx) => {
                const start = this.formatTime(seg.start);
                const end = this.formatTime(seg.end);
                return `${idx + 1}\n${start} --> ${end}\n${seg.text}\n`;
            })
            .join('\n');
    }

    /**
     * Format time ke SRT format (HH:MM:SS,mmm)
     */
    private static formatTime(seconds: number): string {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = Math.floor(seconds % 60);
        const millis = Math.floor((seconds % 1) * 1000);

        return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
    }
}
