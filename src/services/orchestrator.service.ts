import path from 'path';
import fs from 'fs';
import { log } from '../utils/logger';
import { ENV } from '../config/env';
import { YouTubeService, VideoInfo } from './youtube.service';
import {
    AIAnalyzer,
    CandidateRerankResult,
    DiscoveryWindow,
    HighlightSegment,
    TopicDiscoveryCandidate
} from './ai-analyzer.service';
import { FFmpegService } from './ffmpeg.service';
import { WhisperService, TranscriptionSegment } from './whisper.service';
import { TTSService } from './tts.service';
import { SubtitleService } from './subtitle.service';
import { S3Service } from './s3.service';
import { JobManager, TopicCandidate } from './job-manager.service';
import { AudioAnalyzerService, AudioAnalysis } from './audio-analyzer.service';
import { FaceAnalysis, FaceDetectorService } from './face-detector.service';
import { PortraitConverterService } from './portrait-converter.service';
import { ClipCustomization } from '../queue/queues';
import { SubtitleOptions } from './subtitle.service';

export interface ClipResult {
    jobId: string;
    videoUrl: string;
    analysisUrl: string;
    thumbnailUrl?: string;
    postingTitle: string;
    caption: string;
    captionWithHashtags: string;
    hashtags: string[];
    duration: number;
    metadata: {
        sourceTitle: string;
        highlights: number;
    };
}

export interface ProcessClipOptions {
    selectedCandidates?: TopicCandidate[];
    customization?: ClipCustomization;
    minOutputDuration?: number;
    maxOutputDuration?: number;
}

interface TopicDiscoveryArtifacts {
    topicDiscoveryJsonPath: string;
    topicDiscoveryMarkdownPath: string;
}

export class Orchestrator {
    private static getProjectResultDir(videoTitle: string, jobId: string): string {
        const safeTitle = videoTitle.replace(/[^a-z0-9]/gi, '_').toLowerCase();
        const projectResultDir = path.resolve(ENV.RESULTS_DIR, `${safeTitle}_${jobId.substring(0, 4)}`);
        if (!fs.existsSync(projectResultDir)) {
            fs.mkdirSync(projectResultDir, { recursive: true });
        }

        return projectResultDir;
    }

    private static buildUploadPath(jobId: string, fileName: string): string {
        const safeFileName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
        return `${ENV.S3_UPLOAD_PREFIX}/${jobId}/${safeFileName}`;
    }

    private static cleanupDirectory(dirPath: string, enabled: boolean, label: string): boolean {
        if (!enabled || !dirPath || !fs.existsSync(dirPath)) {
            return false;
        }

        try {
            fs.rmSync(dirPath, { recursive: true, force: true });
            log.info({ dirPath, label }, '[CLEANUP] Removed local directory');
            return true;
        } catch (error) {
            log.warn({ dirPath, label, err: error }, '[CLEANUP] Failed to remove local directory');
            return false;
        }
    }

    private static buildSubtitleOptions(
        customization: ClipCustomization | undefined,
        defaults: { stylePreset: string; maxLinesPerDisplay: number }
    ): SubtitleOptions {
        const font = customization?.font;

        return {
            stylePreset: font?.stylePreset || defaults.stylePreset,
            maxLinesPerDisplay: defaults.maxLinesPerDisplay,
            customStyle: {
                ...(font?.family ? { font: font.family } : {}),
                ...(typeof font?.size === 'number' && Number.isFinite(font.size) ? { size: font.size } : {})
            }
        };
    }

    private static getValidRequestedFilters(customization: ClipCustomization | undefined): string[] {
        return (customization?.filters || [])
            .map((value) => String(value || '').trim())
            .filter(Boolean);
    }

    private static buildSelectionSummary(
        videoTitle: string,
        selectedCandidates: TopicCandidate[] | undefined,
        highlights: HighlightSegment[]
    ): string {
        if (selectedCandidates && selectedCandidates.length > 0) {
            return selectedCandidates
                .slice(0, 3)
                .map((candidate) => candidate.summary)
                .filter(Boolean)
                .join(' | ');
        }

        const highlightSummary = highlights
            .filter((highlight) => highlight.action !== 'discard')
            .slice(0, 4)
            .map((highlight) => highlight.reason)
            .filter(Boolean)
            .join(' | ');

        return highlightSummary || videoTitle;
    }

    private static getAverageFaceConfidence(faceAnalysis: FaceAnalysis | null): number {
        const detections = faceAnalysis?.facDetections || [];
        if (detections.length === 0) {
            return 0;
        }

        const totalConfidence = detections.reduce((sum, detection) => sum + detection.confidence, 0);
        return Number((totalConfidence / detections.length).toFixed(4));
    }

    private static findFirstFileByExtension(dirPath: string, extension: string): string | undefined {
        if (!fs.existsSync(dirPath)) {
            return undefined;
        }

        const normalizedExtension = extension.toLowerCase();
        const matches = fs.readdirSync(dirPath)
            .filter((fileName) => fileName.toLowerCase().endsWith(normalizedExtension))
            .map((fileName) => path.join(dirPath, fileName));

        if (matches.length === 0) {
            return undefined;
        }

        matches.sort((left, right) => fs.statSync(right).size - fs.statSync(left).size);
        return matches[0];
    }

    private static async resolveSourceVideo(jobId: string, youtubeUrl: string, workDir: string): Promise<{ filePath: string; info: VideoInfo }> {
        const reusablePaths = [
            this.findFirstFileByExtension(workDir, '.mp4'),
            this.findFirstFileByExtension(path.join(ENV.TEMP_DIR, `${jobId}-discovery`), '.mp4')
        ].filter((value): value is string => Boolean(value));

        if (reusablePaths.length > 0) {
            const reusedPath = reusablePaths[0];
            const info = await YouTubeService.getVideoInfo(youtubeUrl);
            log.info({ reusedPath }, '[FAST-PATH] Reusing previously downloaded source video');
            return { filePath: reusedPath, info };
        }

        return YouTubeService.download(youtubeUrl, workDir);
    }

    private static buildAudioFallbackCandidates(
        audioAnalysis: AudioAnalysis | undefined,
        videoDuration: number
    ): TopicCandidate[] {
        const peaks = audioAnalysis?.peaks || [];
        if (peaks.length === 0) return [];

        const sortedPeaks = [...peaks].sort((a, b) => b.intensity - a.intensity);
        const windows: Array<{ start: number; end: number; intensity: number }> = [];
        const targetWindowDuration = Math.max(60, Math.min(ENV.MAX_OUTPUT_DURATION * 0.75, 135));
        const leadInSeconds = Math.min(20, Math.max(12, Math.round(targetWindowDuration * 0.25)));
        const tailSeconds = Math.max(40, Math.round(targetWindowDuration - leadInSeconds));

        for (const peak of sortedPeaks) {
            const start = Math.max(0, peak.timestamp - leadInSeconds);
            const end = Math.min(videoDuration, peak.timestamp + tailSeconds);

            const overlaps = windows.some((w) => !(end <= w.start || start >= w.end));
            if (overlaps) continue;

            windows.push({ start, end, intensity: peak.intensity });
            if (windows.length >= 5) break;
        }

        return windows.map((w, idx) => ({
            topicId: `topic_${idx + 1}`,
            start: w.start,
            end: w.end,
            summary: `Audio intensity spike around ${Math.round((w.start + w.end) / 2)}s`,
            scoreViral: Math.min(95, Math.round(45 + w.intensity * 50)),
            reasons: ['Audio peak fallback', 'Transcript unavailable'],
            confidence: Math.min(0.85, Math.max(0.45, w.intensity))
        }));
    }

    private static summarizeTranscriptExcerpt(text: string, maxLength: number = 320): string {
        const normalized = text.replace(/\s+/g, ' ').trim();
        if (normalized.length <= maxLength) {
            return normalized;
        }

        const head = normalized.slice(0, Math.max(120, maxLength - 90)).trim();
        const tail = normalized.slice(-70).trim();
        return `${head} ... ${tail}`;
    }

    private static countPeaksInRange(audioAnalysis: AudioAnalysis | undefined, start: number, end: number): number {
        return (audioAnalysis?.peaks || []).filter((peak) => peak.timestamp >= start && peak.timestamp <= end).length;
    }

    private static getWindowIntroSetupPenalty(transcriptExcerpt: string, start: number, videoDuration: number): {
        penalty: number;
        reason?: string;
    } {
        const text = transcriptExcerpt.toLowerCase();
        const introPattern = /(halo|selamat datang|kembali di|podcast|episode kali ini|mari kita mulai|senang bisa menyapa|agar anda mendapat pemahaman|forum ini|silakan|mumpung hadir|pertanyaan saya mulai|kita mulai)/i;
        const outroPattern = /(terima kasih|sampai jumpa|jangan pernah lelah|selesai|demikian|itulah tadi|penutup)/i;
        const strongSignalPattern = /(korupsi|oligarki|hakim|presiden|skandal|kritik|serang|bongkar|ternyata|konflik|krisis|keadilan|pidato|intervensi|mahkamah|kpk|demokrasi)/i;

        if (start <= 240 && introPattern.test(text) && !strongSignalPattern.test(text)) {
            return { penalty: 2.4, reason: 'intro_or_setup' };
        }

        if (start >= Math.max(0, videoDuration - 120) && outroPattern.test(text) && !strongSignalPattern.test(text)) {
            return { penalty: 2, reason: 'outro_or_closing' };
        }

        return { penalty: 0 };
    }

    private static isLowValueDiscoveryWindow(
        transcriptExcerpt: string,
        start: number,
        duration: number,
        videoDuration: number,
        heuristicScore: number,
        peakCount: number
    ): boolean {
        const text = transcriptExcerpt.toLowerCase();
        const lowValueMetaPattern = /(halo|selamat datang|podcast|episode kali ini|senang bisa menyapa|mari kita mulai|sebelum kita mulai|ikuti terus|simak sampai akhir|baik, kita mulai|silakan tanya)/i;
        const highValuePattern = /(korupsi|oligarki|keadilan|hakim|presiden|kpk|mahkamah|bongkar|serang|kritik|intervensi|skandal|ternyata|krisis|demokrasi|konstitusi)/i;
        const { penalty } = this.getWindowIntroSetupPenalty(transcriptExcerpt, start, videoDuration);

        return penalty >= 2
            && lowValueMetaPattern.test(text)
            && !highValuePattern.test(text)
            && duration >= 35
            && peakCount <= 2
            && heuristicScore < 4.8;
    }

    private static buildDiscoveryWindows(
        transcriptionSegments: TranscriptionSegment[],
        audioAnalysis: AudioAnalysis | undefined,
        videoDuration: number
    ): DiscoveryWindow[] {
        if (!transcriptionSegments || transcriptionSegments.length === 0) {
            return [];
        }

        type RawWindow = {
            start: number;
            end: number;
            transcriptExcerpt: string;
            audioScore: number;
            peakCount: number;
            heuristicScore: number;
        };

        const rawWindows: RawWindow[] = [];
        let currentStart = transcriptionSegments[0].start;
        let currentEnd = transcriptionSegments[0].end;
        let currentText = transcriptionSegments[0].text;
        const maxWindowDuration = Math.max(55, Math.min(95, ENV.MAX_OUTPUT_DURATION));

        const flushWindow = (): void => {
            const duration = currentEnd - currentStart;
            if (duration < 16) {
                return;
            }

            const transcriptExcerpt = this.summarizeTranscriptExcerpt(currentText);
            const audioScore = AudioAnalyzerService.estimateAudioScore(audioAnalysis?.peaks || [], currentStart, currentEnd);
            const peakCount = this.countPeaksInRange(audioAnalysis, currentStart, currentEnd);
            const words = transcriptExcerpt.split(/\s+/).filter(Boolean).length;
            const wordsPerSecond = words / Math.max(1, duration);
            const conflictBoost = /(ternyata|bongkar|skandal|serang|kritik|ancam|marah|tegas|gagal|rahasia|konflik|diserang|dibongkar|disorot|dibela|dibantah|menyerang|mengungkap)/i.test(transcriptExcerpt) ? 1.2 : 0;
            const punctuationBoost = (transcriptExcerpt.match(/[!?]/g)?.length || 0) * 0.2;
            const { penalty, reason: penaltyReason } = this.getWindowIntroSetupPenalty(transcriptExcerpt, currentStart, videoDuration);
            const heuristicScore =
                Math.min(duration, 100) * 0.025 +
                Math.min(wordsPerSecond, 4) * 0.9 +
                audioScore +
                peakCount * 0.08 +
                conflictBoost +
                punctuationBoost -
                penalty;

            if (this.isLowValueDiscoveryWindow(
                transcriptExcerpt,
                currentStart,
                duration,
                videoDuration,
                heuristicScore,
                peakCount
            )) {
                log.info(
                    {
                        start: currentStart,
                        end: currentEnd,
                        penaltyReason
                    },
                    'Dropping low-value discovery window before AI topic scouting'
                );
                return;
            }

            rawWindows.push({
                start: currentStart,
                end: Math.min(videoDuration, currentEnd),
                transcriptExcerpt,
                audioScore: Number(audioScore.toFixed(3)),
                peakCount,
                heuristicScore: Number(heuristicScore.toFixed(3))
            });
        };

        for (let index = 1; index < transcriptionSegments.length; index++) {
            const segment = transcriptionSegments[index];
            const previous = transcriptionSegments[index - 1];
            const gap = segment.start - previous.end;
            const wouldExceedWindow = Math.max(currentEnd, segment.end) - currentStart > maxWindowDuration;

            if (gap > 2.5 || wouldExceedWindow) {
                flushWindow();
                currentStart = segment.start;
                currentEnd = segment.end;
                currentText = segment.text;
                continue;
            }

            currentEnd = segment.end;
            currentText = `${currentText} ${segment.text}`;
        }

        flushWindow();

        const selectedWindows = rawWindows.length <= 18
            ? rawWindows
            : (() => {
                const topByScore = [...rawWindows]
                    .sort((left, right) => right.heuristicScore - left.heuristicScore)
                    .slice(0, 12);
                const coverageWindows = [rawWindows[0], rawWindows[1], rawWindows[rawWindows.length - 2], rawWindows[rawWindows.length - 1]]
                    .filter(Boolean);
                const unique = new Map<string, RawWindow>();

                for (const window of [...coverageWindows, ...topByScore]) {
                    unique.set(`${window.start}-${window.end}`, window);
                }

                return [...unique.values()]
                    .sort((left, right) => left.start - right.start)
                    .slice(0, 18);
            })();

        return selectedWindows.map((window, index) => ({
            windowId: `window_${index + 1}`,
            duration: Number((window.end - window.start).toFixed(1)),
            ...window
        }));
    }

    private static computeOverlapRatio(
        left: { start: number; end: number },
        right: { start: number; end: number }
    ): number {
        const overlap = Math.max(0, Math.min(left.end, right.end) - Math.max(left.start, right.start));
        const shortestDuration = Math.max(1, Math.min(left.end - left.start, right.end - right.start));
        return overlap / shortestDuration;
    }

    private static mergeAiTopicCandidates(
        aiTopics: TopicDiscoveryCandidate[],
        heuristicCandidates: TopicCandidate[],
        videoDuration: number
    ): TopicCandidate[] {
        if (aiTopics.length === 0) {
            return [];
        }

        const normalized = aiTopics
            .map((topic, index) => {
                const start = Math.max(0, Math.min(videoDuration - 1, topic.start));
                const end = Math.max(start + 8, Math.min(videoDuration, topic.end));
                const supportingCandidate = heuristicCandidates
                    .filter((candidate) => this.computeOverlapRatio({ start, end }, candidate) >= 0.2)
                    .sort((left, right) => right.scoreViral - left.scoreViral)[0];
                const heuristicSupportScore = supportingCandidate?.scoreViral || 0;
                const patternBias = this.computeViralPatternBias(topic);
                const blendedScore = Math.round(Math.max(
                    topic.scoreViral,
                    Math.min(100, topic.scoreViral * 0.8 + heuristicSupportScore * 0.12 + patternBias.scoreBonus)
                ));
                const reasons = [
                    topic.hook,
                    topic.whyItCanSpread,
                    `Primary emotion: ${topic.primaryEmotion}`,
                    ...topic.reasonTags.map((tag) => `Signal: ${tag}`),
                    ...patternBias.matchedPatterns.map((pattern) => `Viral pattern: ${pattern}`)
                ].filter(Boolean);

                if (supportingCandidate) {
                    reasons.push(`Transcript/audio support: ${supportingCandidate.summary}`);
                }

                return {
                    topicId: `topic_${index + 1}`,
                    start,
                    end,
                    summary: `${topic.title}: ${topic.summary}`,
                    scoreViral: blendedScore,
                    reasons: reasons.slice(0, 6),
                    confidence: Math.max(
                        0.45,
                        Math.min(0.99, topic.confidence * 0.85 + (supportingCandidate?.confidence || 0.5) * 0.15)
                    )
                };
            })
            .filter((candidate) => candidate.end - candidate.start >= 12)
            .sort((left, right) => right.scoreViral - left.scoreViral);

        const deduped: TopicCandidate[] = [];
        for (const candidate of normalized) {
            const overlapsExisting = deduped.some((existing) => this.computeOverlapRatio(existing, candidate) >= 0.55);
            if (overlapsExisting) {
                continue;
            }

            deduped.push(candidate);
            if (deduped.length >= 5) {
                break;
            }
        }

        return deduped;
    }

    private static computeViralPatternBias(topic: TopicDiscoveryCandidate): {
        scoreBonus: number;
        matchedPatterns: string[];
    } {
        const corpus = [
            topic.title,
            topic.summary,
            topic.hook,
            topic.whyItCanSpread,
            topic.primaryEmotion,
            ...topic.reasonTags
        ].join(' ').toLowerCase();

        const patterns: Array<{ label: string; regex: RegExp; weight: number }> = [
            {
                label: 'conflict',
                regex: /(konflik|serang|kritik|debat|bantah|lawan|bongkar|diserang|memukul|menekan|menantang|skandal|clash|attack|controversy|rebuttal)/i,
                weight: 8
            },
            {
                label: 'novelty',
                regex: /(ternyata|tak terduga|mengejutkan|baru|jarang|unexpected|surprising|counter|novel|unik|belum banyak diketahui)/i,
                weight: 6
            },
            {
                label: 'authority_clash',
                regex: /(presiden|menteri|hakim|jenderal|dosen|pakar|ahli|ketua|institusi|pemerintah|mahkamah|otoritas|tokoh|official|authority)/i,
                weight: 7
            },
            {
                label: 'strong_takeaway',
                regex: /(kesimpulan|akibatnya|artinya|pelajarannya|pesannya|intinya|warning|peringatan|verdict|takeaway|ujungnya|dampaknya)/i,
                weight: 7
            }
        ];

        const matchedPatterns = patterns
            .filter((pattern) => pattern.regex.test(corpus))
            .map((pattern) => pattern.label);
        const scoreBonus = patterns
            .filter((pattern) => matchedPatterns.includes(pattern.label))
            .reduce((sum, pattern) => sum + pattern.weight, 0);

        return {
            scoreBonus: Math.min(18, scoreBonus),
            matchedPatterns
        };
    }

    private static writeTopicDiscoveryArtifacts(
        projectResultDir: string,
        videoInfo: VideoInfo,
        discoveryWindows: DiscoveryWindow[],
        heuristicCandidates: TopicCandidate[],
        aiTopics: TopicDiscoveryCandidate[],
        finalCandidates: TopicCandidate[]
    ): TopicDiscoveryArtifacts {
        const topicDiscoveryJsonPath = path.join(projectResultDir, 'topic_discovery.json');
        const topicDiscoveryMarkdownPath = path.join(projectResultDir, 'topic_discovery.md');

        const jsonPayload = {
            source: {
                title: videoInfo.title,
                duration: videoInfo.duration
            },
            discoveryWindows,
            heuristicCandidates,
            aiTopics,
            finalCandidates,
            generatedAt: new Date().toISOString()
        };

        const markdown = [
            '# Topic Discovery Audit',
            '',
            `Title: ${videoInfo.title}`,
            `Duration: ${videoInfo.duration}s`,
            '',
            '## Final Candidates',
            '',
            ...finalCandidates.flatMap((candidate, index) => [
                `### ${index + 1}. ${candidate.topicId}`,
                `- Range: ${candidate.start}s - ${candidate.end}s`,
                `- Score: ${candidate.scoreViral}`,
                `- Confidence: ${candidate.confidence}`,
                `- Summary: ${candidate.summary}`,
                `- Reasons: ${candidate.reasons.join(' | ')}`,
                ''
            ]),
            '## AI Topics',
            '',
            ...aiTopics.flatMap((topic, index) => [
                `### ${index + 1}. ${topic.title}`,
                `- Range: ${topic.start}s - ${topic.end}s`,
                `- Viral score: ${topic.scoreViral}`,
                `- Confidence: ${topic.confidence}`,
                `- Hook: ${topic.hook}`,
                `- Spread thesis: ${topic.whyItCanSpread}`,
                `- Tags: ${topic.reasonTags.join(', ')}`,
                ''
            ]),
            '## Heuristic Candidates',
            '',
            ...heuristicCandidates.flatMap((candidate, index) => [
                `### ${index + 1}. ${candidate.topicId}`,
                `- Range: ${candidate.start}s - ${candidate.end}s`,
                `- Score: ${candidate.scoreViral}`,
                `- Summary: ${candidate.summary}`,
                ''
            ])
        ].join('\n');

        fs.writeFileSync(topicDiscoveryJsonPath, JSON.stringify(jsonPayload, null, 2));
        fs.writeFileSync(topicDiscoveryMarkdownPath, markdown);

        return {
            topicDiscoveryJsonPath,
            topicDiscoveryMarkdownPath
        };
    }

    private static buildTopicCandidatesFromTranscript(
        transcriptionSegments: TranscriptionSegment[],
        audioAnalysis: AudioAnalysis | undefined,
        videoDuration: number
    ): TopicCandidate[] {
        const smartCuts = this.buildSmartAutoCuts(transcriptionSegments, audioAnalysis, videoDuration);

        if (smartCuts.length === 0) {
            const audioFallback = this.buildAudioFallbackCandidates(audioAnalysis, videoDuration);
            if (audioFallback.length > 0) {
                return audioFallback.sort((a, b) => b.scoreViral - a.scoreViral);
            }

            const variableFallback = this.buildVariableFallbackCuts(videoDuration);
            return variableFallback.map((segment, idx) => ({
                topicId: `topic_${idx + 1}`,
                start: segment.start,
                end: segment.end,
                summary: segment.reason,
                scoreViral: Math.max(35, 60 - idx * 5),
                reasons: ['Variable fallback', 'No transcript/audio candidate available'],
                confidence: 0.4
            }));
        }

        return smartCuts
            .map((segment, idx) => {
                const duration = Math.max(1, segment.end - segment.start);
                const scoreViral = Math.min(100, Math.round(55 + duration * 0.6));
                return {
                    topicId: `topic_${idx + 1}`,
                    start: segment.start,
                    end: segment.end,
                    summary: segment.reason,
                    scoreViral,
                    reasons: [segment.reason, 'Transcript/audio scoring'],
                    confidence: Math.min(0.95, Math.max(0.55, scoreViral / 100))
                };
            })
            .sort((a, b) => b.scoreViral - a.scoreViral);
    }

    private static selectHighlightsByCandidates(candidates: TopicCandidate[]): HighlightSegment[] {
        return candidates
            .map((c, idx) => ({
                start: c.start,
                end: c.end,
                action: idx === 0 ? 'hook' : 'keep',
                reason: `Selected topic ${c.topicId} (${c.scoreViral})`,
                needsTTS: false,
                narrativeText: null
            }));
    }

    private static getCandidateSignalCorpus(candidate: TopicCandidate): string {
        return [candidate.summary, ...candidate.reasons].join(' ').toLowerCase();
    }

    private static buildContextAwareSelectedHighlights(
        candidates: TopicCandidate[],
        videoDuration: number,
        configuredMaxOutputDuration: number
    ): { highlights: HighlightSegment[]; preferredMaxDuration: number } {
        const normalizedCandidates = candidates.map((candidate, index) => {
            const start = Math.max(0, Math.min(videoDuration - 1, candidate.start));
            const end = Math.max(start + 8, Math.min(videoDuration, candidate.end));
            const originalDuration = end - start;
            const signalCorpus = this.getCandidateSignalCorpus(candidate);

            const conflictBoost = /(conflict|konflik|serang|kritik|debat|bantah|skandal|clash|controversy)/i.test(signalCorpus) ? 14 : 0;
            const noveltyBoost = /(novelty|counter|kontra|counterintuitive|counter-intuitive|unexpected|surprising|kebaruan|membantah|ternyata)/i.test(signalCorpus) ? 12 : 0;
            const authorityBoost = /(authority|otoritas|hakim|presiden|menteri|ketua|institusi|kpk|mahkamah|judikatif)/i.test(signalCorpus) ? 10 : 0;
            const takeawayBoost = /(takeaway|pelajaran|warning|peringatan|verdict|kesimpulan|intinya|akibatnya|dampaknya)/i.test(signalCorpus) ? 12 : 0;
            const emotionalBoost = /(emosi|emotional|anger|marah|nangis|shock|despair|outrage|kemarahan|frustrasi|keterkejutan)/i.test(signalCorpus) ? 8 : 0;
            const scoreBonus = Math.max(0, (candidate.scoreViral - 80) * 0.65);
            const confidenceBonus = Math.max(0, (candidate.confidence - 0.75) * 45);
            const baseDuration = candidates.length === 1
                ? 78
                : index === 0
                    ? 52
                    : 42;

            const preferredDuration = Math.round(
                baseDuration +
                scoreBonus +
                confidenceBonus +
                conflictBoost +
                noveltyBoost +
                authorityBoost +
                takeawayBoost +
                emotionalBoost
            );
            const durationCap = candidates.length === 1
                ? 140
                : index === 0
                    ? 95
                    : 85;
            const trimmedDuration = Math.max(
                28,
                Math.min(originalDuration, durationCap, preferredDuration)
            );

            return {
                candidate,
                start,
                end,
                originalDuration,
                allocatedDuration: trimmedDuration,
                priorityScore: candidate.scoreViral + candidate.confidence * 10
            };
        });

        const originalTotal = normalizedCandidates.reduce((sum, item) => sum + item.originalDuration, 0);
        let targetTotal = normalizedCandidates.reduce((sum, item) => sum + item.allocatedDuration, 0);
        const baselineTarget = candidates.length <= 1 ? 78 : 110;
        const desiredTotal = Math.min(configuredMaxOutputDuration, Math.min(originalTotal, Math.max(baselineTarget, targetTotal)));

        if (targetTotal < desiredTotal) {
            const ordered = [...normalizedCandidates]
                .sort((left, right) => right.priorityScore - left.priorityScore);

            for (const item of ordered) {
                if (targetTotal >= desiredTotal) {
                    break;
                }

                const remainingCapacity = item.originalDuration - item.allocatedDuration;
                if (remainingCapacity <= 0) {
                    continue;
                }

                const grant = Math.min(remainingCapacity, desiredTotal - targetTotal);
                item.allocatedDuration += grant;
                targetTotal += grant;
            }
        }

        const highlights: HighlightSegment[] = normalizedCandidates.map((item, index) => ({
            start: item.start,
            end: Math.min(item.end, item.start + item.allocatedDuration),
            action: index === 0 ? 'hook' : 'keep',
            reason: `Selected topic ${item.candidate.topicId} (${item.candidate.scoreViral}); context-aware duration targeting`,
            needsTTS: false,
            narrativeText: null
        }));

        const preferredMaxDuration = Math.min(
            configuredMaxOutputDuration,
            Math.max(
                70,
                targetTotal + (candidates.length === 1 ? 8 : 12)
            )
        );

        return {
            highlights,
            preferredMaxDuration
        };
    }

    private static applyVisionRerank(
        candidates: TopicCandidate[],
        reranked: CandidateRerankResult[]
    ): TopicCandidate[] {
        if (reranked.length === 0) {
            return candidates;
        }

        const adjustments = new Map(reranked.map((item) => [item.topicId, item]));

        return candidates
            .map((candidate) => {
                const adjustment = adjustments.get(candidate.topicId);
                if (!adjustment) {
                    return candidate;
                }

                const nextScore = Math.max(0, Math.min(100, candidate.scoreViral + adjustment.scoreAdjustment));
                return {
                    ...candidate,
                    scoreViral: nextScore,
                    reasons: [...candidate.reasons, `Vision rerank: ${adjustment.reason}`],
                    confidence: Math.min(0.98, candidate.confidence + Math.abs(adjustment.scoreAdjustment) / 100)
                };
            })
            .sort((left, right) => right.scoreViral - left.scoreViral);
    }

    static async discoverTopics(
        youtubeUrl: string,
        jobId: string
    ): Promise<{ videoInfo: VideoInfo; candidates: TopicCandidate[]; topicDiscoveryJsonPath: string; topicDiscoveryMarkdownPath: string }> {
        const workDir = path.join(ENV.TEMP_DIR, `${jobId}-discovery`);
        if (!fs.existsSync(workDir)) {
            fs.mkdirSync(workDir, { recursive: true });
        }

        const { filePath: videoPath, info: videoInfo } = await this.resolveSourceVideo(jobId, youtubeUrl, workDir);

        await JobManager.updateJob(jobId, {
            status: 'extracting_audio',
            progress: 20,
            stage: 'extracting_audio',
            message: 'Extracting audio for discovery'
        });

        const audioPath = path.join(workDir, 'audio.mp3');
        if (fs.existsSync(audioPath) && fs.statSync(audioPath).size > 0) {
            log.info({ audioPath }, '[FAST-PATH] Reusing previously extracted discovery audio');
        } else {
            await FFmpegService.extractAudio(videoPath, audioPath);
        }

        await JobManager.updateJob(jobId, {
            status: 'transcribing',
            progress: 32,
            stage: 'transcribing',
            message: 'Transcribing for topic discovery'
        });

        let transcriptionSegments: TranscriptionSegment[] = [];
        let audioAnalysis: AudioAnalysis | undefined = {
            peaks: [],
            silences: [],
            avgIntensity: 0,
            suggestedCutPoints: []
        };

        const [transcriptionResult, audioAnalysisResult] = await Promise.allSettled([
            WhisperService.transcribe(audioPath),
            AudioAnalyzerService.analyzeAudio(audioPath)
        ]);

        if (transcriptionResult.status === 'fulfilled') {
            transcriptionSegments = transcriptionResult.value;
        }

        if (audioAnalysisResult.status === 'fulfilled') {
            audioAnalysis = audioAnalysisResult.value;
        }

        const heuristicCandidates = this.buildTopicCandidatesFromTranscript(
            transcriptionSegments,
            audioAnalysis,
            videoInfo.duration || 0
        );

        let candidates = heuristicCandidates;
        let discoveryWindows: DiscoveryWindow[] = [];
        let aiTopics: TopicDiscoveryCandidate[] = [];

        if (transcriptionSegments.length > 0) {
            discoveryWindows = this.buildDiscoveryWindows(
                transcriptionSegments,
                audioAnalysis,
                videoInfo.duration || 0
            );
            const aiDiscovery = await AIAnalyzer.discoverViralTopics(
                videoInfo.title,
                videoInfo.duration || 0,
                discoveryWindows
            );
            aiTopics = aiDiscovery.topics;
            const aiCandidates = this.mergeAiTopicCandidates(
                aiDiscovery.topics,
                heuristicCandidates,
                videoInfo.duration || 0
            );

            if (aiCandidates.length > 0) {
                candidates = aiCandidates;
                log.info(
                    {
                        windowsAnalyzed: discoveryWindows.length,
                        candidateCount: aiCandidates.length,
                        topScore: aiCandidates[0]?.scoreViral
                    },
                    'AI-led topic discovery selected primary candidates'
                );
            } else {
                log.warn('AI-led topic discovery returned no usable candidates, keeping transcript/audio heuristic candidates');
            }
        }

        const projectResultDir = this.getProjectResultDir(videoInfo.title, jobId);
        const discoveryArtifacts = this.writeTopicDiscoveryArtifacts(
            projectResultDir,
            videoInfo,
            discoveryWindows,
            heuristicCandidates,
            aiTopics,
            candidates
        );
        log.info(discoveryArtifacts, '[DOC] Topic discovery audit artifacts saved');

        if (ENV.DISCOVERY_VISION_RERANK_ENABLED && candidates.length > 0) {
            const topN = Math.max(1, ENV.DISCOVERY_VISION_RERANK_TOP_N);
            const rerankTargets = candidates.slice(0, topN);
            const previewPath = path.join(workDir, 'preview.mp4');
            let publicPreviewUrl = '';

            try {
                await FFmpegService.generatePreview(videoPath, previewPath);
                publicPreviewUrl = await S3Service.uploadFile(previewPath, `ytdl/${jobId}_preview.mp4`);
            } catch (err) {
                log.warn({ err }, 'Vision rerank preview preparation failed, using transcript/audio ranking only');
            }

            if (publicPreviewUrl) {
                const reranked = await AIAnalyzer.rerankCandidatesWithVision(
                    videoInfo.title,
                    publicPreviewUrl,
                    rerankTargets.map((candidate) => ({
                        topicId: candidate.topicId,
                        start: candidate.start,
                        end: candidate.end,
                        summary: candidate.summary,
                        scoreViral: candidate.scoreViral
                    }))
                );

                candidates = this.applyVisionRerank(candidates, reranked);
            }
        }

        return {
            videoInfo,
            candidates,
            ...discoveryArtifacts
        };
    }
    private static normalizeHighlights(highlights: HighlightSegment[], videoDuration: number): HighlightSegment[] {
        return (highlights || [])
            .map((h) => {
                const start = Math.max(0, Math.min(videoDuration - 1, h.start ?? 0));
                const end = Math.max(start + 4, Math.min(videoDuration, h.end ?? start + 20));
                return {
                    ...h,
                    start,
                    end,
                    action: h.action || 'keep',
                    reason: h.reason || 'Normalized segment'
                };
            })
            .filter((h) => h.end - h.start >= 4);
    }

    private static isLikelyGenericPlan(highlights: HighlightSegment[]): boolean {
        const keeps = highlights.filter(h => h.action === 'keep');
        if (keeps.length < 2) return true;

        const durations = keeps.map(h => h.end - h.start);
        const avg = durations.reduce((s, d) => s + d, 0) / durations.length;
        const variance = durations.reduce((s, d) => s + Math.pow(d - avg, 2), 0) / durations.length;
        const stdDev = Math.sqrt(variance);

        // Low variation usually indicates equal-split fallback style.
        return stdDev < 4;
    }

    private static buildSmartAutoCuts(
        transcriptionSegments: TranscriptionSegment[],
        audioAnalysis: AudioAnalysis | undefined,
        videoDuration: number
    ): HighlightSegment[] {
        if (!transcriptionSegments || transcriptionSegments.length === 0) return [];

        type Chunk = { start: number; end: number; text: string; score: number };
        const chunks: Chunk[] = [];

        let currentStart = transcriptionSegments[0].start;
        let currentEnd = transcriptionSegments[0].end;
        let currentText = transcriptionSegments[0].text;
        const maxChunkDuration = Math.max(90, Math.min(ENV.MAX_OUTPUT_DURATION, 150));

        for (let i = 1; i < transcriptionSegments.length; i++) {
            const seg = transcriptionSegments[i];
            const prev = transcriptionSegments[i - 1];
            const gap = seg.start - prev.end;
            const currentDuration = currentEnd - currentStart;

            const shouldSplit = gap > 2.2 || currentDuration > maxChunkDuration;
            if (shouldSplit) {
                if (currentDuration >= 14) {
                    chunks.push({ start: currentStart, end: currentEnd, text: currentText, score: 0 });
                }
                currentStart = seg.start;
                currentEnd = seg.end;
                currentText = seg.text;
            } else {
                currentEnd = seg.end;
                currentText = `${currentText} ${seg.text}`;
            }
        }

        if (currentEnd - currentStart >= 14) {
            chunks.push({ start: currentStart, end: currentEnd, text: currentText, score: 0 });
        }

        const viralKeywords = /(ternyata|fakta|bongkar|skandal|kpk|korupsi|viral|serius|mendesak|krusial|penting|drama|konflik|kaget|wow)/i;
        for (const c of chunks) {
            const duration = c.end - c.start;
            const words = c.text.split(/\s+/).filter(Boolean).length;
            const wordsPerSecond = words / Math.max(1, duration);
            const punctuationBoost = (c.text.match(/[!?]/g)?.length || 0) * 0.15;
            const keywordBoost = viralKeywords.test(c.text) ? 1 : 0;
            const audioBoost = AudioAnalyzerService.estimateAudioScore(audioAnalysis?.peaks || [], c.start, c.end);

            c.score =
                Math.min(duration, 120) * 0.03 +
                Math.min(wordsPerSecond, 4) * 0.8 +
                punctuationBoost +
                keywordBoost +
                audioBoost;
        }

        chunks.sort((a, b) => b.score - a.score);

        const chosen: Chunk[] = [];
        for (const c of chunks) {
            const overlaps = chosen.some(x => !(c.end <= x.start || c.start >= x.end));
            if (overlaps) continue;
            chosen.push(c);
            if (chosen.length >= 5) break;
        }

        return chosen
            .sort((a, b) => a.start - b.start)
            .map((c, idx) => ({
                start: Math.max(0, c.start),
                end: Math.min(videoDuration, c.end),
                action: idx === 0 ? 'hook' : 'keep',
                reason: `Smart cut score=${c.score.toFixed(2)} from transcript/audio analysis`,
                needsTTS: false,
                narrativeText: null
            }));
    }

    private static buildVariableFallbackCuts(videoDuration: number): HighlightSegment[] {
        const weights = [0.17, 0.23, 0.14, 0.26, 0.2];
        const count = Math.min(5, Math.max(3, Math.ceil(videoDuration / 120)));
        const used = weights.slice(0, count);
        const sum = used.reduce((a, b) => a + b, 0);
        const fallbackBudget = Math.min(videoDuration, Math.max(150, ENV.MAX_OUTPUT_DURATION));

        let cursor = 0;
        const cuts: HighlightSegment[] = [];
        for (let i = 0; i < used.length; i++) {
            const dur = (used[i] / sum) * fallbackBudget;
            const start = cursor;
            const end = Math.min(videoDuration, start + dur);
            cursor = end + 2;
            cuts.push({
                start,
                end,
                action: i === 0 ? 'hook' : 'keep',
                reason: `Variable fallback segment ${i + 1}`,
                needsTTS: false,
                narrativeText: null
            });
        }

        return cuts.filter(c => c.end - c.start >= 8);
    }

    private static enforceDurationGuardrail(
        highlights: HighlightSegment[],
        fallbackPool: HighlightSegment[],
        minOutputDuration: number,
        maxOutputDuration: number
    ): HighlightSegment[] {
        const selected = highlights.filter((h) => h.action === 'keep' || h.action === 'hook');
        let totalDuration = selected.reduce((sum, h) => sum + (h.end - h.start), 0);

        if (totalDuration > maxOutputDuration) {
            return this.trimHighlightsToMaxDuration(selected, maxOutputDuration);
        }

        if (totalDuration >= minOutputDuration) {
            return selected;
        }

        const used = new Set(selected.map((s) => `${s.start}-${s.end}`));
        const pool = fallbackPool
            .filter((h) => (h.action === 'keep' || h.action === 'hook') && !used.has(`${h.start}-${h.end}`))
            .sort((a, b) => (b.end - b.start) - (a.end - a.start));

        for (const candidate of pool) {
            const nextTotal = totalDuration + (candidate.end - candidate.start);
            if (nextTotal > maxOutputDuration + 18) continue;

            selected.push({
                ...candidate,
                reason: `${candidate.reason}; auto-extended to satisfy min duration`
            });
            totalDuration = nextTotal;

            if (totalDuration >= minOutputDuration) {
                break;
            }
        }

        if (totalDuration > maxOutputDuration) {
            return this.trimHighlightsToMaxDuration(selected, maxOutputDuration);
        }

        return selected;
    }

    private static trimHighlightsToMaxDuration(
        highlights: HighlightSegment[],
        maxOutputDuration: number
    ): HighlightSegment[] {
        const selected = [...highlights];
        if (selected.length === 0) {
            return selected;
        }

        const totalDuration = selected.reduce((sum, segment) => sum + (segment.end - segment.start), 0);
        if (totalDuration <= maxOutputDuration) {
            return selected;
        }

        if (selected.length === 1) {
            const segment = selected[0];
            return [{
                ...segment,
                end: Math.min(segment.end, segment.start + maxOutputDuration),
                reason: `${segment.reason}; trimmed to max duration`
            }];
        }

        const segmentCount = selected.length;
        const baseDuration = Math.max(8, Math.min(20, Math.floor(maxOutputDuration / segmentCount)));
        const originalDurations = selected.map((segment) => Math.max(1, segment.end - segment.start));
        const clampedBaseDurations = originalDurations.map((duration) => Math.min(duration, baseDuration));
        const baseTotal = clampedBaseDurations.reduce((sum, duration) => sum + duration, 0);
        let remainingBudget = Math.max(0, maxOutputDuration - baseTotal);

        const expandable = originalDurations.map((duration, index) => Math.max(0, duration - clampedBaseDurations[index]));
        const totalExpandable = expandable.reduce((sum, duration) => sum + duration, 0);
        const allocated = [...clampedBaseDurations];

        if (remainingBudget > 0 && totalExpandable > 0) {
            const shares = expandable.map((duration) => (duration / totalExpandable) * remainingBudget);
            const wholeShares = shares.map((share) => Math.floor(share));

            for (let i = 0; i < allocated.length; i++) {
                allocated[i] += wholeShares[i];
            }

            remainingBudget -= wholeShares.reduce((sum, share) => sum + share, 0);

            const order = shares
                .map((share, index) => ({ index, fraction: share - Math.floor(share), expandable: expandable[index] }))
                .sort((left, right) => right.fraction - left.fraction || right.expandable - left.expandable);

            for (const item of order) {
                if (remainingBudget <= 0) {
                    break;
                }

                if (allocated[item.index] < originalDurations[item.index]) {
                    allocated[item.index] += 1;
                    remainingBudget -= 1;
                }
            }
        }

        return selected.map((segment, index) => ({
            ...segment,
            end: Math.min(segment.end, segment.start + allocated[index]),
            reason: `${segment.reason}; trimmed to fit total max duration`
        }));
    }

    /**
     * Main flow: YouTube URL → Analysis → Highlights → Narasi → Render
     */
    static async processYouTubeToClip(
        youtubeUrl: string,
        jobId: string,
        webhookUrl?: string,
        options: ProcessClipOptions = {}
    ): Promise<ClipResult> {
        const workDir = path.join(ENV.TEMP_DIR, jobId);

        // Create work directory
        if (!fs.existsSync(workDir)) {
            fs.mkdirSync(workDir, { recursive: true });
        }

        try {
            log.info({ youtubeUrl, jobId }, '[START] Starting clip generation pipeline');
            JobManager.updateJob(jobId, { status: 'downloading', progress: 5, message: 'Starting YouTube download...' });

            // Step 1: Download from YouTube
            log.info('[1/6] Downloading video...');
            const { filePath: videoPath, info: videoInfo } = await this.resolveSourceVideo(
                jobId,
                youtubeUrl,
                workDir
            );

            const hasSelectedCandidates = Boolean(options.selectedCandidates && options.selectedCandidates.length > 0);
            const projectResultDir = this.getProjectResultDir(videoInfo.title, jobId);

            let audioAnalysis: AudioAnalysis | undefined = {
                peaks: [],
                silences: [],
                avgIntensity: 0,
                suggestedCutPoints: []
            };
            let transcriptionSegments: TranscriptionSegment[] = [];
            let directorCut: { highlights: HighlightSegment[]; markdown: string } = {
                highlights: [],
                markdown: '# Fast Path Render\n\nNo AI director plan was generated for this run.'
            };

            const reportPath = path.join(projectResultDir, 'analysis.md');
            const audioAnalysisPath = path.join(projectResultDir, 'audio_analysis.json');

            if (hasSelectedCandidates) {
                log.info(
                    { selectedCandidates: options.selectedCandidates?.length },
                    '[FAST-PATH] Selected topics provided, skipping full transcript and AI planning'
                );

                fs.writeFileSync(
                    reportPath,
                    [
                        '# Fast Path Render',
                        '',
                        'Selected topic candidates were provided by discovery/selection.',
                        'The pipeline skipped full-audio transcription, preview upload, Data Agent, and Director Agent',
                        'to render the chosen topic faster.'
                    ].join('\n')
                );
                log.info({ reportPath }, '[DOC] Fast path analysis markdown saved');

                fs.writeFileSync(audioAnalysisPath, JSON.stringify(audioAnalysis, null, 2));
                log.info({ audioAnalysisPath }, '[DOC] Fast path audio analysis placeholder saved');
            } else {

                // Step 2: Extract audio for analysis
                log.info('[2/6] Extracting audio for transcription...');
                JobManager.updateJob(jobId, { status: 'extracting_audio', progress: 20, message: 'Extracting audio for transcription...' });
                const audioPath = path.join(workDir, 'audio.mp3');
                if (fs.existsSync(audioPath) && fs.statSync(audioPath).size > 0) {
                    log.info({ audioPath }, '[FAST-PATH] Reusing previously extracted audio');
                } else {
                    await FFmpegService.extractAudio(videoPath, audioPath);
                }

                // Step 3: Run audio analysis and Whisper in parallel.
                log.info('[3/6] Running audio analysis and transcription in parallel...');
                JobManager.updateJob(jobId, { status: 'transcribing', progress: 30, message: 'Transcribing audio and analyzing peaks...' });

                const [audioAnalysisResult, transcriptionResult] = await Promise.allSettled([
                    AudioAnalyzerService.analyzeAudio(audioPath),
                    WhisperService.transcribe(audioPath)
                ]);

                if (audioAnalysisResult.status === 'fulfilled') {
                    audioAnalysis = audioAnalysisResult.value;
                    log.info({
                        peaks: audioAnalysis.peaks.length,
                        silences: audioAnalysis.silences.length,
                        cutPoints: audioAnalysis.suggestedCutPoints.length
                    }, '✅ Audio analysis complete');
                } else {
                    log.warn({ err: audioAnalysisResult.reason }, '⚠️ Audio analysis failed, continuing without it');
                }

                if (transcriptionResult.status === 'fulfilled') {
                    transcriptionSegments = transcriptionResult.value;
                    log.info({ count: transcriptionSegments.length }, 'Transcription segments obtained');

                    const srtPath = path.join(workDir, 'transcript.srt');
                    fs.writeFileSync(srtPath, WhisperService.generateSRT(transcriptionSegments));
                    log.info({ srtPath }, '[SUCCESS] SRT file written');
                } else {
                    log.warn({ err: transcriptionResult.reason }, 'Transcription failed, continuing without transcript');
                }

                const formattedTranscript = transcriptionSegments
                    .map(s => `[${s.start}s - ${s.end}s] ${s.text}`)
                    .join('\n');

                // Step 4a: Create preview and run AI Data Agent analysis
                log.info('[4/6] Creating preview and analyzing data...');
                JobManager.updateJob(jobId, { status: 'analyzing', progress: 40, message: 'Extracting chronological facts via AI Data Agent...' });
                const previewPath = path.join(workDir, 'preview.mp4');
                try {
                    await FFmpegService.generatePreview(videoPath, previewPath);
                } catch (ffmpegErr) {
                    log.warn({ err: ffmpegErr }, 'Preview generation failed, AI vision might be impaired, trying to proceed anyway');
                }

                log.info('[4.5/6] Uploading preview to Cloudflare R2...');
                let publicPreviewUrl = '';
                try {
                    publicPreviewUrl = await S3Service.uploadFile(previewPath, `ytdl/${jobId}_preview.mp4`);
                } catch (r2Err) {
                    log.warn({ err: r2Err }, 'R2 Upload failed, AI vision might be impaired if URL is required');
                }

                const factualData = await AIAnalyzer.analyzeData(videoInfo.title, publicPreviewUrl, formattedTranscript);

                log.info('[5/6] Director Agent planning viral viral clip...');
                JobManager.updateJob(jobId, { status: 'analyzing', progress: 55, message: 'Director Agent is crafting the viral storyline...' });
                directorCut = await AIAnalyzer.directViralClip(videoInfo.title, factualData);

                fs.writeFileSync(reportPath, directorCut.markdown);
                log.info({ reportPath }, '[DOC] Analysis markdown saved');

                fs.writeFileSync(audioAnalysisPath, JSON.stringify({
                    peaks: audioAnalysis?.peaks || [],
                    silences: audioAnalysis?.silences || [],
                    avgIntensity: audioAnalysis?.avgIntensity || 0,
                    suggestedCutPoints: audioAnalysis?.suggestedCutPoints || []
                }, null, 2));
                log.info({ audioAnalysisPath }, '[DOC] Audio analysis saved');
            }

            // Step 5: Generate narasi dan cut highlights
            log.info('[6/6] Cutting highlights...');
            JobManager.updateJob(jobId, { status: 'cutting', progress: 65, message: 'Cutting video highlights based on Director analysis...' });
            const cutSegments: string[] = [];
            const segmentsDir = path.join(projectResultDir, 'segments');
            if (!fs.existsSync(segmentsDir)) fs.mkdirSync(segmentsDir, { recursive: true });

            const videoDuration = videoInfo.duration || 420;
            const contextAwareSelection = options.selectedCandidates && options.selectedCandidates.length > 0
                ? this.buildContextAwareSelectedHighlights(
                    options.selectedCandidates,
                    videoDuration,
                    options.maxOutputDuration || ENV.MAX_OUTPUT_DURATION
                )
                : null;
            const selectedHighlights = contextAwareSelection
                ? contextAwareSelection.highlights
                : [];

            let highlightsToProcess = selectedHighlights.length > 0
                ? this.normalizeHighlights(selectedHighlights, videoDuration)
                : this.normalizeHighlights(directorCut.highlights, videoDuration);

            const keepSegmentCount = highlightsToProcess.filter(h => h.action === 'keep').length;
            const genericDirectorPlan = this.isLikelyGenericPlan(highlightsToProcess);

            if (selectedHighlights.length === 0 && (highlightsToProcess.length === 0 || keepSegmentCount < 2 || genericDirectorPlan)) {
                log.warn(
                    { keepSegmentCount, genericDirectorPlan },
                    'Director output not strong enough, activating smart transcript-driven auto-cuts...'
                );

                const smartCuts = this.buildSmartAutoCuts(
                    transcriptionSegments,
                    audioAnalysis,
                    videoDuration
                );

                if (smartCuts.length > 0) {
                    highlightsToProcess = smartCuts;
                    log.info({ count: highlightsToProcess.length, method: 'smart-transcript-audio' }, '✅ Smart auto-cuts activated');
                } else {
                    highlightsToProcess = this.buildVariableFallbackCuts(videoDuration);
                    log.info({ count: highlightsToProcess.length, method: 'variable-fallback' }, '✅ Variable fallback cuts activated');
                }
            }

            const minOutputDuration = options.minOutputDuration || ENV.MIN_OUTPUT_DURATION;
            const maxOutputDuration = contextAwareSelection?.preferredMaxDuration || options.maxOutputDuration || ENV.MAX_OUTPUT_DURATION;
            const fallbackGuardrailPool = hasSelectedCandidates
                ? []
                : this.normalizeHighlights(
                    this.buildSmartAutoCuts(transcriptionSegments, audioAnalysis, videoDuration),
                    videoDuration
                );

            if (contextAwareSelection) {
                log.info(
                    {
                        selectedCandidates: options.selectedCandidates?.length,
                        preferredMaxDuration: contextAwareSelection.preferredMaxDuration,
                        contextAwareDuration: contextAwareSelection.highlights
                            .reduce((sum, seg) => sum + (seg.end - seg.start), 0)
                            .toFixed(1)
                    },
                    'Applying context-aware duration targeting for selected topics'
                );
            }

            highlightsToProcess = this.enforceDurationGuardrail(
                highlightsToProcess,
                fallbackGuardrailPool,
                minOutputDuration,
                maxOutputDuration
            );

            log.info(
                {
                    minOutputDuration,
                    maxOutputDuration,
                    selectedSegments: highlightsToProcess.length,
                    totalDuration: highlightsToProcess
                        .reduce((sum, seg) => sum + (seg.end - seg.start), 0)
                        .toFixed(1)
                },
                '[GUARDRAIL] Duration guardrail applied'
            );

            for (let i = 0; i < highlightsToProcess.length; i++) {
                const highlight = highlightsToProcess[i];
                if (highlight.action === 'discard') {
                    log.info({ reason: highlight.reason }, `Skipping segment ${i} (action: discard)`);
                    continue;
                }

                const segmentPath = path.join(segmentsDir, `segment_${i + 1}.mp4`);
                const mixedSegmentPath = path.join(segmentsDir, `segment_${i + 1}_tts_mixed.mp4`);

                await FFmpegService.cutSegment(
                    videoPath,
                    segmentPath,
                    highlight.start,
                    highlight.end
                );

                if (highlight.needsTTS && highlight.narrativeText) {
                    const ttsPath = path.join(segmentsDir, `segment_${i + 1}_tts.mp3`);
                    try {
                        await TTSService.generateVoice(
                            highlight.narrativeText,
                            ttsPath,
                            ENV.TTS_PROVIDER
                        );
                        await FFmpegService.mixAudio(
                            segmentPath,
                            ttsPath,
                            mixedSegmentPath,
                            0.8
                        );
                        cutSegments.push(mixedSegmentPath);
                    } catch (err) {
                        log.warn('TTS generation failed for segment, skipping TTS for this segment');
                        cutSegments.push(segmentPath);
                    }
                } else {
                    cutSegments.push(segmentPath);
                }
            }

            // Concat all segments
            const concatPath = path.join(workDir, 'concat.mp4');
            let outputVideoPath: string;

            if (cutSegments.length > 1) {
                outputVideoPath = await FFmpegService.concat(cutSegments, concatPath);
            } else if (cutSegments.length === 1) {
                outputVideoPath = cutSegments[0];
            } else {
                if (selectedHighlights.length > 0) {
                    throw new Error('Selected highlights produced no renderable segments');
                }
                // Fallback ke full video jika tidak ada highlights
                log.warn('No highlights found, using full video');
                outputVideoPath = videoPath;
            }

            await PortraitConverterService.assertValidVideo(outputVideoPath);

            // Global TTS feature is removed. Director Agent is explicit per segment.
            log.info('[TASK] Skipping global narrative (Director agent manages per-segment bridges)');

            // ===== FIX #1: RE-TRANSCRIPTION OF CONCATENATED VIDEO =====
            // After concatenation, re-transcribe to get accurate subtitle timing
            log.info('[TASK] Re-transcribing concatenated video for accurate subtitles...');
            let concatTranscriptionSegments: TranscriptionSegment[] = [];
            try {
                concatTranscriptionSegments = await WhisperService.transcribe(outputVideoPath);
                log.info(
                    { count: concatTranscriptionSegments.length },
                    '✅ Concatenated video re-transcription complete'
                );

                // Save concat transcript for reference
                const concatSrtPath = path.join(projectResultDir, 'concat_transcript.srt');
                fs.writeFileSync(
                    concatSrtPath,
                    WhisperService.generateSRT(concatTranscriptionSegments)
                );
                log.info({ concatSrtPath }, '[DOC] Concatenated transcript saved');
            } catch (err) {
                log.warn(
                    { err },
                    '⚠️ Re-transcription of concatenated video failed, falling back to original transcription'
                );
                concatTranscriptionSegments = transcriptionSegments;
            }

            // Generate subtitles using CONCAT transcription (accurate timing)
            // IMPORTANT: Only for reference, will be applied at portrait stage
            log.info('[TASK] Generating subtitle data from concatenated video...');
            const assSubtitlePath = path.join(projectResultDir, 'subtitles_landscape.ass');

            let subtitleSegments = concatTranscriptionSegments;
            if (subtitleSegments.length === 0) {
                // Fallback: Create title subtitle if no transcription
                subtitleSegments = [{
                    start: 1,
                    end: Math.min(videoInfo.duration, 10), // Show for first 10 seconds or video duration
                    text: videoInfo.title
                }];
                log.info('Using title as fallback subtitle');
            }

            const landscapeSubtitleOptions = this.buildSubtitleOptions(options.customization, {
                stylePreset: 'basic',
                maxLinesPerDisplay: 3
            });
            const assLandscapeContent = SubtitleService.generateASS(
                subtitleSegments,
                '1920x1080',
                landscapeSubtitleOptions
            );
            fs.writeFileSync(assSubtitlePath, assLandscapeContent);
            log.info({ assSubtitlePath }, '[DOC] Landscape ASS saved (for reference)');

            // NO SUBTITLE APPLICATION HERE - Will apply at portrait stage with karaoke
            const finalVideoPath = outputVideoPath; // Skip subtitle application for now

            // == PHASE 2: FACE DETECTION & PORTRAIT MODE ==
            
            // Step 6: Detect faces in video for subject tracking
            log.info('[6/7] Detecting faces for subject tracking...');
            JobManager.updateJob(jobId, { status: 'analyzing_faces', progress: 80, message: 'Detecting faces for portrait conversion...' });
            let faceAnalysis: FaceAnalysis | null = null;
            try {
                faceAnalysis = await FaceDetectorService.analyzeVideoForFaces(outputVideoPath);
                log.info(
                    { facesFound: faceAnalysis.faceCount, framesAnalyzed: faceAnalysis.totalFrames },
                    '[👁️ Face Detection] Complete'
                );
                
                // Save face analysis data
                const faceAnalysisPath = path.join(projectResultDir, 'face_analysis.json');
                fs.writeFileSync(faceAnalysisPath, JSON.stringify(faceAnalysis, null, 2));
                log.info({ faceAnalysisPath }, '[DOC] Face analysis saved');
            } catch (err) {
                log.warn({ err }, '[👁️ Face Detection] Failed, skipping portrait conversion');
                faceAnalysis = null;
            }

            // Step 7: Convert to portrait format (9:16) for social media with blur background fallback
            const portraitVideoTargetPath = path.join(projectResultDir, 'final_video_portrait_no_subs.mp4');
            const portraitWithSubtitlesPath = path.join(projectResultDir, 'final_video_portrait.mp4');
            let portraitVideoPath: string | undefined;
            let finalOutputPath = finalVideoPath;
            let portraitAssPath = assSubtitlePath; // Default to landscape ASS
            let portraitDecisionPath: string | undefined;

            log.info('[7/7] Converting to portrait format (9:16) for mobile...');
            JobManager.updateJob(jobId, { status: 'converting_format', progress: 85, message: 'Converting to portrait 9:16 format...' });

            try {
                    // Always convert to portrait, even when face detection is unavailable.
                    // This guarantees 9:16 output and avoids silently returning landscape clips.
                    const videoDimensions = await PortraitConverterService.getVideoDimensions(finalVideoPath);
                    const fallbackCropBox = PortraitConverterService.getFallbackCropBox(videoDimensions);
                    const cropBox = faceAnalysis?.recommendedCropBox || fallbackCropBox;
                    const faceConfidence = this.getAverageFaceConfidence(faceAnalysis);
                    const portraitPlan = PortraitConverterService.planPortraitRender(videoDimensions, cropBox, {
                        usedFaceDetection: Boolean(faceAnalysis?.recommendedCropBox),
                        faceConfidence
                    });
                    portraitDecisionPath = path.join(projectResultDir, 'portrait_decision.json');
                    const portraitDecision = {
                        sourceDimensions: videoDimensions,
                        usedFaceDetection: Boolean(faceAnalysis?.recommendedCropBox),
                        faceConfidence,
                        ...portraitPlan
                    };

                    if (!fs.existsSync(projectResultDir)) {
                        fs.mkdirSync(projectResultDir, { recursive: true });
                    }
                    fs.writeFileSync(portraitDecisionPath, JSON.stringify(portraitDecision, null, 2));

                    if (!fs.existsSync(portraitDecisionPath)) {
                        throw new Error(`Portrait decision audit file was not created: ${portraitDecisionPath}`);
                    }

                    log.info(
                        {
                            mode: portraitPlan.mode,
                            usedFaceDetection: portraitDecision.usedFaceDetection,
                            faceConfidence,
                            requestedCropBox: portraitPlan.requestedCropBox,
                            safeSubjectBox: portraitPlan.safeSubjectBox,
                            portraitWindow: portraitPlan.portraitWindow,
                            reasons: portraitPlan.reasons,
                            portraitDecisionPath
                        },
                        '[📱 Portrait] Render plan selected'
                    );

                    // ===== KARAOKE ASS GENERATION FOR PORTRAIT =====
                    // Generate portrait-specific karaoke subtitle with per-word highlighting
                    log.info('[TASK] Generating karaoke subtitle for portrait format...');
                    portraitAssPath = path.join(projectResultDir, 'subtitles_portrait_karaoke.ass');
                    const portraitResolution = '1080x1920'; // Standard portrait resolution
                    
                    const portraitSubtitleOptions = this.buildSubtitleOptions(options.customization, {
                        stylePreset: 'karaoke_yellow',
                        maxLinesPerDisplay: 3
                    });
                    const portraitKaraokeContent = SubtitleService.generateKaraokeASS(
                        subtitleSegments,
                        portraitResolution,
                        {
                            ...portraitSubtitleOptions,
                            animationPreset: ''
                        }
                    );
                    fs.writeFileSync(portraitAssPath, portraitKaraokeContent);
                    log.info(
                        { resolution: portraitResolution, path: portraitAssPath },
                        '[✨ Karaoke] Portrait karaoke subtitle generated'
                    );

                    try {
                        log.info('[TASK] Converting to portrait video with embedded karaoke subtitle...');
                        if (portraitPlan.mode === 'blur_fallback') {
                            log.info({ reasons: portraitPlan.reasons }, '[📱 Portrait] Using subject-aware blur fallback');
                            await PortraitConverterService.convertWithBlurFallback(
                                finalVideoPath,
                                portraitWithSubtitlesPath,
                                cropBox,
                                1080,
                                1920,
                                portraitAssPath
                            );
                        } else {
                            const portraitResult = await PortraitConverterService.convertToPortrait(
                                finalVideoPath,
                                portraitWithSubtitlesPath,
                                cropBox,
                                portraitAssPath
                            );

                            log.info(
                                { format: portraitResult.format, method: portraitResult.conversionMethod },
                                '[📱 Portrait] Conversion complete'
                            );
                        }

                        await PortraitConverterService.assertValidVideo(portraitWithSubtitlesPath);
                        portraitVideoPath = portraitWithSubtitlesPath;
                        finalOutputPath = portraitWithSubtitlesPath;
                        log.info('[✅ SUCCESS] Portrait video with karaoke subtitle created in one pass');
                    } catch (subErr) {
                        log.warn({ err: subErr }, 'One-pass portrait+subtitle render failed, falling back to portrait video without subtitles');

                        if (portraitPlan.mode === 'blur_fallback') {
                            await PortraitConverterService.convertWithBlurFallback(
                                finalVideoPath,
                                portraitVideoTargetPath,
                                cropBox,
                                1080,
                                1920
                            );
                        } else {
                            await PortraitConverterService.convertToPortrait(
                                finalVideoPath,
                                portraitVideoTargetPath,
                                cropBox
                            );
                        }

                        await PortraitConverterService.assertValidVideo(portraitVideoTargetPath);
                        portraitVideoPath = portraitVideoTargetPath;
                        finalOutputPath = portraitVideoPath;
                    }
                } catch (err) {
                    log.warn({ err }, '[📱 Portrait] Conversion failed, using original video');
                    // Fall back to original video
                }

            const requestedFilters = this.getValidRequestedFilters(options.customization);
            if (requestedFilters.length > 0) {
                const filteredOutputPath = path.join(projectResultDir, 'final_video_filtered.mp4');
                log.info({ requestedFilters }, '[FILTER] Applying requested final video filters');
                finalOutputPath = await FFmpegService.applyNamedFilters(
                    finalOutputPath,
                    filteredOutputPath,
                    requestedFilters
                );
            }

            // Generate thumbnail from final video
            log.info('[TASK] Generating thumbnail...');
            const thumbnailPath = path.join(projectResultDir, 'thumbnail.jpg');
            try {
                await FFmpegService.generateThumbnail(finalOutputPath, thumbnailPath, 1);
            } catch (err) {
                log.warn({ err: (err as any).message }, 'Thumbnail generation failed, skipping');
                // Create a placeholder thumbnail or skip
            }

            log.info({ jobId }, '[SUCCESS] Clip generation complete');

            const actualOutputDuration = await FFmpegService.getDurationSeconds(finalOutputPath)
                .catch(() => highlightsToProcess.reduce((sum, seg) => sum + (seg.end - seg.start), 0));

            const analysisMarkdown = fs.existsSync(reportPath)
                ? fs.readFileSync(reportPath, 'utf8')
                : '# Analysis\n\nAnalysis file was not generated.';
            const selectionSummary = this.buildSelectionSummary(
                videoInfo.title,
                options.selectedCandidates,
                highlightsToProcess
            );
            const publishMetadata = await AIAnalyzer.generatePublishMetadata(
                videoInfo.title,
                analysisMarkdown,
                selectionSummary,
                options.customization
            );
            const captionWithHashtags = [publishMetadata.caption, publishMetadata.hashtags.join(' ')]
                .filter(Boolean)
                .join('\n\n')
                .trim();

            const videoUrl = await S3Service.uploadFile(
                finalOutputPath,
                this.buildUploadPath(jobId, path.basename(finalOutputPath))
            );
            const analysisUrl = await S3Service.uploadFile(
                reportPath,
                this.buildUploadPath(jobId, path.basename(reportPath))
            );
            const thumbnailUrl = fs.existsSync(thumbnailPath)
                ? await S3Service.uploadFile(
                    thumbnailPath,
                    this.buildUploadPath(jobId, path.basename(thumbnailPath))
                )
                : undefined;

            const result: ClipResult = {
                jobId,
                videoUrl,
                analysisUrl,
                thumbnailUrl,
                postingTitle: publishMetadata.postingTitle,
                caption: publishMetadata.caption,
                captionWithHashtags,
                hashtags: publishMetadata.hashtags,
                duration: Number(actualOutputDuration.toFixed(3)),
                metadata: {
                    sourceTitle: videoInfo.title,
                    highlights: cutSegments.length
                }
            };

            const cleanup = {
                tempDirRemoved: this.cleanupDirectory(workDir, ENV.CLEANUP_TEMP_FILES, 'workdir'),
                discoveryDirRemoved: this.cleanupDirectory(
                    path.join(ENV.TEMP_DIR, `${jobId}-discovery`),
                    ENV.CLEANUP_TEMP_FILES,
                    'discovery'
                ),
                resultDirRemoved: this.cleanupDirectory(projectResultDir, ENV.CLEANUP_RESULT_FILES, 'result')
            };

            await JobManager.updateJob(jobId, {
                status: 'completed',
                progress: 100,
                stage: 'completed',
                message: 'Video processing completed successfully',
                result,
                artifacts: {
                    videoUrl: result.videoUrl,
                    analysisUrl: result.analysisUrl,
                    thumbnailUrl: result.thumbnailUrl,
                    portraitDecisionPath,
                    cleanup
                }
            });

            return result;

        } catch (err: any) {
            log.error({ err: err.message, jobId }, '[ERROR] Clip generation failed');
            await JobManager.updateJob(jobId, {
                status: 'failed',
                progress: 100,
                stage: 'failed',
                message: err.message,
                error: err.stack
            });

            throw err;
        }
    }
}
