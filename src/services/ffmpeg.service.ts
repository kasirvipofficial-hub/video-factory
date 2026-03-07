import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import fs from 'fs';
import { log } from '../utils/logger';
import { ENV } from '../config/env';
import { FilterService } from './filter.service';

ffmpeg.setFfmpegPath(ENV.FFMPEG_PATH);

export class FFmpegService {
    static async applyNamedFilters(
        inputPath: string,
        outputPath: string,
        filterNames: string[]
    ): Promise<string> {
        const validFilters = filterNames
            .map((name) => String(name || '').trim())
            .filter(Boolean)
            .filter((name, index, all) => all.indexOf(name) === index)
            .filter((name) => FilterService.filterExists(name));

        if (validFilters.length === 0) {
            fs.copyFileSync(inputPath, outputPath);
            return outputPath;
        }

        const filterChain = FilterService.combineFilters(...validFilters);

        return new Promise((resolve, reject) => {
            log.info({ validFilters, filterChain }, '[FILTER] Applying named video filters');

            ffmpeg(inputPath)
                .output(outputPath)
                .videoFilters(filterChain)
                .videoCodec('libx264')
                .audioCodec('aac')
                .outputOptions(['-preset veryfast', '-crf 20', '-movflags +faststart'])
                .on('end', () => {
                    log.info({ outputPath, validFilters }, '[SUCCESS] Video filters applied');
                    resolve(outputPath);
                })
                .on('error', (err) => {
                    log.error({ err: err.message, validFilters }, '[ERROR] Video filter application failed');
                    reject(err);
                })
                .run();
        });
    }

    static async getDurationSeconds(mediaPath: string): Promise<number> {
        return new Promise((resolve, reject) => {
            ffmpeg.ffprobe(mediaPath, (err, metadata) => {
                if (err) {
                    reject(err);
                    return;
                }

                const duration = metadata.format?.duration;
                if (typeof duration !== 'number' || !Number.isFinite(duration)) {
                    reject(new Error(`Could not determine media duration for ${mediaPath}`));
                    return;
                }

                resolve(duration);
            });
        });
    }

    /**
     * Extract audio dari video
     */
    static async extractAudio(videoPath: string, outputPath: string): Promise<string> {
        return new Promise((resolve, reject) => {
            log.info({ videoPath }, '[AUDIO] Extracting audio');

            ffmpeg(videoPath)
                .output(outputPath)
                .audioCodec('libmp3lame')
                .audioBitrate('192k')
                .audioChannels(2)
                .audioFrequency(44100)
                .on('end', () => {
                    log.info({ outputPath }, '[SUCCESS] Audio extracted');
                    resolve(outputPath);
                })
                .on('error', (err) => {
                    log.error({ err: err.message }, '[ERROR] Audio extraction failed');
                    reject(err);
                })
                .run();
        });
    }

    /**
     * Cut segment dari video dengan audio preservation (copy codec)
     */
    static async cutSegment(
        inputPath: string,
        outputPath: string,
        startTime: number,
        endTime: number
    ): Promise<string> {
        return new Promise((resolve, reject) => {
            const duration = endTime - startTime;
            log.info({ startTime, endTime, duration }, '[CUT] Cutting segment (re-encode mode)');

            ffmpeg(inputPath)
                .setStartTime(startTime)
                .duration(duration)
                .output(outputPath)
                .videoCodec('libx264')
                .audioCodec('aac')
                .outputOptions(['-preset veryfast', '-crf 20', '-movflags +faststart'])
                .on('end', () => {
                    log.info({ outputPath }, '[SUCCESS] Segment cut');
                    resolve(outputPath);
                })
                .on('error', (err) => {
                    log.error({ err: err.message }, '[ERROR] Cut failed');
                    reject(err);
                })
                .run();
        });
    }

    /**
     * Concat multiple video segments with audio preservation
     */
    static async concat(
        segmentFiles: string[],
        outputPath: string,
        metadata?: { title?: string; artist?: string }
    ): Promise<string> {
        return new Promise((resolve, reject) => {
            log.info({ segmentCount: segmentFiles.length }, '[JOIN] Concatenating segments (re-encode mode)');

            // Create concat demuxer file
            const concatFile = path.join(path.dirname(outputPath), 'concat.txt');
            const concatContent = segmentFiles
                .map(f => `file '${f.replace(/\\/g, '/')}'`)
                .join('\n');
            fs.writeFileSync(concatFile, concatContent);

            ffmpeg()
                .input(concatFile)
                .inputOptions(['-f concat', '-safe 0'])
                .output(outputPath)
                .videoCodec('libx264')
                .audioCodec('aac')
                .outputOptions(['-preset veryfast', '-crf 20', '-movflags +faststart'])
                .on('end', () => {
                    // Cleanup concat file
                    try { fs.unlinkSync(concatFile); } catch (e) { }
                    log.info({ outputPath }, '[SUCCESS] Concatenation complete');
                    resolve(outputPath);
                })
                .on('error', (err) => {
                    log.error({ err: err.message }, '[ERROR] Concatenation failed');
                    reject(err);
                })
                .run();
        });
    }

    /**
     * Apply color grading / LUT
     */
    static async applyColorGrade(
        inputPath: string,
        outputPath: string,
        lut?: string,
        brightness?: number,
        contrast?: number
    ): Promise<string> {
        return new Promise((resolve, reject) => {
            log.info({ lut, brightness, contrast }, '[COLOR] Applying color grade');

            let filterChain = '';
            if (brightness !== undefined || contrast !== undefined) {
                const b = brightness ?? 0;
                const c = contrast ?? 0;
                filterChain += `eq=brightness=${b}:contrast=${c}`;
            }
            if (lut) {
                if (filterChain) filterChain += ',';
                filterChain += `lut3d=${lut}`;
            }

            const cmd = ffmpeg(inputPath)
                .output(outputPath);

            if (filterChain) {
                cmd.videoFilters(filterChain);
            }

            cmd
                .videoCodec('libx264')
                .audioCodec('aac')
                .preset('veryfast')
                .on('end', () => {
                    log.info({ outputPath }, '[SUCCESS] Color grade applied');
                    resolve(outputPath);
                })
                .on('error', (err) => {
                    log.error({ err: err.message }, '[ERROR] Color grade failed');
                    reject(err);
                })
                .run();
        });
    }

    /**
     * Scale dan crop video
     */
    static async scaleAndCrop(
        inputPath: string,
        outputPath: string,
        resolution: string = '1920x1080'
    ): Promise<string> {
        return new Promise((resolve, reject) => {
            log.info({ resolution }, '[SCALE] Scaling and cropping');

            const [width, height] = resolution.split('x').map(Number);

            ffmpeg(inputPath)
                .output(outputPath)
                .videoFilters(`scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`)
                .videoCodec('libx264')
                .audioCodec('aac')
                .on('end', () => {
                    log.info({ outputPath }, '[SUCCESS] Scale and crop complete');
                    resolve(outputPath);
                })
                .on('error', (err) => {
                    log.error({ err: err.message }, '[ERROR] Scale and crop failed');
                    reject(err);
                })
                .run();
        });
    }

    /**
     * Add subtitles ke video
     */
    static async addSubtitles(
        inputPath: string,
        subtitlePath: string,
        outputPath: string
    ): Promise<string> {
        return new Promise(async (resolve, reject) => {
            try {
                log.info({ subtitlePath }, '[SUB] Adding subtitles');

                // Use shell command for more reliable subtitle handling
                const { exec } = await import('child_process');
                const { promisify } = await import('util');
                const execAsync = promisify(exec);

                // FFmpeg subtitle filter with proper escaping
                const subtitleEscaped = subtitlePath.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "'\\''");
                const fontsDir = path.resolve(ENV.FONTS_DIR);
                const fontsDirEscaped = fontsDir.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "'\\''");
                
                // Maintain full quality: use high bitrate and CRF for H.264 encoding
                const ffmpegCmd = 
                    `"${ENV.FFMPEG_PATH}" -i "${inputPath}" -vf "subtitles='${subtitleEscaped}':fontsdir='${fontsDirEscaped}':force_style='Alignment=2,MarginL=10,MarginR=10,MarginV=30',setsar=1" -aspect 9:16 -c:v libx264 -crf 20 -preset superfast -maxrate 5000k -bufsize 10000k -c:a aac -b:a 128k -movflags +faststart -y "${outputPath}"`;

                log.debug({ cmd: ffmpegCmd }, '[SUB] Executing FFmpeg subtitle command');

                const { stdout, stderr } = await execAsync(ffmpegCmd, { 
                    maxBuffer: 10 * 1024 * 1024, 
                    timeout: 600000 
                });

                log.info({ outputPath }, '[SUCCESS] Subtitles added');
                resolve(outputPath);
            } catch (err: any) {
                log.error({ err: err.message }, '[ERROR] Add subtitles failed');
                reject(err);
            }
        });
    }

    /**
     * Mix audio (video audio + background music)
     */
    static async mixAudio(
        videoPath: string,
        audioPath: string,
        outputPath: string,
        audioVolume: number = 0.3
    ): Promise<string> {
        return new Promise((resolve, reject) => {
            log.info({ audioVolume }, '[AUDIO] Mixing audio');

            ffmpeg()
                .input(videoPath)
                .input(audioPath)
                .output(outputPath)
                .audioFilter(`[0:a][1:a]amerge=inputs=2[a];[a]volume=${audioVolume}`)
                .videoCodec('copy')
                .audioCodec('aac')
                .on('end', () => {
                    log.info({ outputPath }, '[SUCCESS] Audio mixed');
                    resolve(outputPath);
                })
                .on('error', (err) => {
                    log.error({ err: err.message }, '[ERROR] Audio mix failed');
                    reject(err);
                })
                .run();
        });
    }

    /**
     * Generate a small preview (3fps 640x360) while preserving audio
     */
    static async generatePreview(
        videoPath: string,
        outputPath: string
    ): Promise<string> {
        return new Promise((resolve, reject) => {
            log.info({ videoPath }, '[PREVIEW] Generating preview video');

            ffmpeg(videoPath)
                .output(outputPath)
                .outputOptions(['-r 3', '-s 640x360', '-c:v libx264', '-preset veryfast', '-crf 28', '-c:a copy'])
                .on('end', () => {
                    log.info({ outputPath }, '[SUCCESS] Preview generated');
                    resolve(outputPath);
                })
                .on('error', (err) => {
                    log.error({ err: err.message }, '[ERROR] Preview generation failed');
                    reject(err);
                })
                .run();
        });
    }

    /**
     * Generate thumbnail dari video
     */
    static async generateThumbnail(
        videoPath: string,
        outputPath: string,
        timeSeconds: number = 1
    ): Promise<string> {
        return new Promise((resolve, reject) => {
            ffmpeg(videoPath)
                .on('start', () => {
                    log.info({ videoPath, timeSeconds }, 'Starting thumbnail extraction');
                })
                .on('end', () => {
                    // Check if file exists
                    if (fs.existsSync(outputPath)) {
                        log.info({ outputPath }, '[SUCCESS] Thumbnail generated');
                        resolve(outputPath);
                    } else {
                        log.warn({ outputPath }, 'Thumbnail path not found, trying alternative');
                        // Try without the folder+filename approach
                        const thumbPath = path.join(path.dirname(outputPath), 'tn.png');
                        if (fs.existsSync(thumbPath)) {
                            fs.renameSync(thumbPath, outputPath);
                            resolve(outputPath);
                        } else {
                            reject(new Error('Thumbnail file not created'));
                        }
                    }
                })
                .on('error', (err) => {
                    log.error({ err: err.message }, '[ERROR] Thumbnail generation failed');
                    reject(err);
                })
                .outputOptions([`-ss ${timeSeconds}`, '-vframes 1', '-q:v 2', '-s 1280x720'])
                .output(outputPath)
                .run();
        });
    }

    /**
     * Cut segment dengan smooth audio transition (fade in/out)
     * Smooth transitions = kehilangan harsh cuts antara segments
     */
    static async cutSegmentSmooth(
        inputPath: string,
        outputPath: string,
        startTime: number,
        endTime: number,
        fadeTime: number = 0.3
    ): Promise<string> {
        return new Promise((resolve, reject) => {
            const duration = endTime - startTime;
            log.info({ startTime, endTime, duration, fadeTime }, '[CUT-SMOOTH] Cutting segment with audio fade');

            ffmpeg(inputPath)
                .setStartTime(startTime)
                .duration(duration)
                .output(outputPath)
                .videoCodec('libx264')
                .audioCodec('aac')
                .outputOptions([
                    '-preset veryfast',
                    '-crf 20',
                    '-movflags +faststart',
                    `-af afade=t=in:st=0:d=${fadeTime},afade=t=out:st=${Math.max(0, duration - fadeTime)}:d=${fadeTime}`
                ])
                .audioBitrate('128k')
                .on('end', () => {
                    log.info({ outputPath }, '[SUCCESS] Segment cut with smooth audio ✅');
                    resolve(outputPath);
                })
                .on('error', (err) => {
                    log.error({ err: err.message }, '[ERROR] Smooth cut failed');
                    reject(err);
                })
                .run();
        });
    }

    /**
     * Apply audio crossfade between segments (smooth concat)
     * Blends audio dari segment terakhir ke segment berikutnya
     */
    static async concatWithCrossfade(
        segmentFiles: string[],
        outputPath: string,
        crossfadeDuration: number = 0.5
    ): Promise<string> {
        return new Promise((resolve, reject) => {
            if (segmentFiles.length === 0) {
                reject(new Error('No segments to concatenate'));
                return;
            }

            if (segmentFiles.length === 1) {
                // Single segment, just copy
                fs.copyFileSync(segmentFiles[0], outputPath);
                resolve(outputPath);
                return;
            }

            log.info({ segmentCount: segmentFiles.length, crossfadeDuration }, '[JOIN-FADE] Concatenating with audio crossfade');

            // Create concat demuxer file
            const concatFile = path.join(path.dirname(outputPath), 'concat.txt');
            const concatContent = segmentFiles
                .map(f => `file '${f.replace(/\\/g, '/')}'`)
                .join('\n');
            fs.writeFileSync(concatFile, concatContent);

            ffmpeg()
                .input(concatFile)
                .inputOptions(['-f concat', '-safe 0'])
                .output(outputPath)
                .audioFilter(`[0:a][1:a]acrossfade=d=${crossfadeDuration}[a]`)
                .videoCodec('copy')
                .audioCodec('aac')
                .on('end', () => {
                    try { fs.unlinkSync(concatFile); } catch (e) { }
                    log.info({ outputPath }, '[SUCCESS] Concatenation with crossfade complete ✅');
                    resolve(outputPath);
                })
                .on('error', (err) => {
                    log.error({ err: err.message }, '[ERROR] Concatenation with crossfade failed');
                    reject(err);
                })
                .run();
        });
    }
}
