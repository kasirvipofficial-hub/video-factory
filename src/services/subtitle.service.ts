import { log } from '../utils/logger';
import { StyleService, StyleConfig } from './style.service';
import { AnimationService } from './animation.service';

export interface SubtitleStyle {
    fontName?: string;
    fontSize?: number;
    color?: string;
    backgroundColor?: string;
    borderStyle?: number; // 1 = outline + shadow, 3 = opaque box
}

export interface WordTiming {
    word: string;
    start: number;
    end: number;
}

/**
 * Options for subtitle generation
 */
export interface SubtitleOptions {
    stylePreset?: string;           // Style preset name (basic, modern_bold, etc.)
    customStyle?: StyleConfig;      // Custom style overrides
    animationPreset?: string;       // Animation preset (fade_inout, slide_up, etc.)
    maxLinesPerDisplay?: number;    // Maximum lines per subtitle display (default: 3)
    wordsPerLine?: number | 'auto'; // Words per line, or 'auto' for smart wrapping
}

export class SubtitleService {
    /**
     * Generate per-word karaoke ASS subtitle file with animation and style support
     * Each word highlights when spoken (like karaoke) with customizable styling
     */
    static generateKaraokeASS(
        segments: Array<{ start: number; end: number; text: string }>,
        resolution: string = '1920x1080',
        options: SubtitleOptions = {}
    ): string {
        const [width, height] = resolution.split('x').map(Number);
        const isPortrait = height > width;

        // Resolve options with defaults
        const stylePreset = options.stylePreset || 'karaoke_yellow';
        const animationPreset = options.animationPreset || '';
        const maxLinesPerDisplay = options.maxLinesPerDisplay || 3;
        const customStyle = options.customStyle || {};

        // Get base style from service
        const styleConfig = StyleService.getStyle(stylePreset);
        const mergedStyle = { ...styleConfig, ...customStyle };

        // Build style strings
        const resolution_obj = { width, height };
        const styleString = StyleService.getStyleString(mergedStyle, {}, resolution_obj);

        // Calculate text wrapping based on font size and resolution
        const fontSize = mergedStyle.size || 70;
        const maxLineLength = this.calculateMaxLineLength(fontSize, width, isPortrait);
        const marginV = mergedStyle.margin_v || (isPortrait ? 80 : 30);
        const marginL = mergedStyle.margin_l || (isPortrait ? 30 : 15);
        const marginR = mergedStyle.margin_r || (isPortrait ? 30 : 15);

        const header = `[Script Info]
Title: Clipper Karaoke Subtitle
Original Script: Clipper
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${styleString}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

        const events: string[] = [];
        const normalizedSegments = this.mergeShortSegments(segments);

        // Process each segment and break into words for karaoke effect
        for (const segment of normalizedSegments) {
            const words = segment.text.trim().split(/\s+/);
            if (words.length === 0) continue;

            // Distribute time evenly among words
            const totalDuration = segment.end - segment.start;
            const totalDurationCs = Math.max(1, Math.round(totalDuration * 100));

            // Use existing wrapping logic, then apply karaoke timing tags per word inside each visual line.
            const wrappedPlainText = this.wrapText(segment.text, maxLineLength, maxLinesPerDisplay);
            const wrappedLines = wrappedPlainText
                .split('\\N')
                .map(line => line.trim())
                .filter(line => line.length > 0);

            const baseDurations = words.map(() => Math.max(1, Math.floor(totalDurationCs / words.length)));
            const assigned = baseDurations.reduce((sum, d) => sum + d, 0);
            baseDurations[baseDurations.length - 1] += (totalDurationCs - assigned);

            let wordIndex = 0;
            const karaokeLines = wrappedLines.map((line) => {
                const lineWords = line.split(/\s+/).filter(w => w.length > 0);
                const taggedWords = lineWords.map(() => {
                    const safeWord = this.escapeAssText(words[wordIndex] || '');
                    const durCs = baseDurations[wordIndex] || 1;
                    wordIndex += 1;
                    return `{\\k${durCs}}${safeWord}`;
                });
                return taggedWords.join(' ');
            });

            const eventStart = this.formatTimeASS(segment.start);
            const eventEnd = this.formatTimeASS(segment.end);
            // Avoid flicker: only apply animation on sufficiently long subtitle blocks.
            const animation = (animationPreset && totalDuration >= 2.2)
                ? AnimationService.getPreset(animationPreset, Math.round(totalDuration * 1000))
                : '';
            const karaokeText = `${animation}{\\1c&HFFFFFF&\\2c&H00FFFF&}${karaokeLines.join('\\N')}`;

            // One dialogue per segment prevents flicker while preserving word-by-word karaoke highlighting.
            events.push(`Dialogue: 0,${eventStart},${eventEnd},Default,,0,0,0,,${karaokeText}`);
        }

        return header + events.join('\n');
    }

    /**
     * Merge short and adjacent segments to reduce subtitle flicker.
     * This keeps karaoke stable by preventing too many rapid event switches.
     */
    private static mergeShortSegments(
        segments: Array<{ start: number; end: number; text: string }>
    ): Array<{ start: number; end: number; text: string }> {
        if (segments.length <= 1) return segments;

        const merged: Array<{ start: number; end: number; text: string }> = [];
        const minDuration = 1.0;
        const maxMergedDuration = 4.5;
        const maxJoinGap = 0.18;

        let current = { ...segments[0], text: segments[0].text.trim() };

        for (let i = 1; i < segments.length; i++) {
            const next = { ...segments[i], text: segments[i].text.trim() };
            const currentDuration = current.end - current.start;
            const gap = next.start - current.end;
            const mergedDuration = next.end - current.start;
            const shouldJoin = (
                (currentDuration < minDuration || /[^.!?]$/.test(current.text)) &&
                gap <= maxJoinGap &&
                mergedDuration <= maxMergedDuration
            );

            if (shouldJoin) {
                current = {
                    start: current.start,
                    end: next.end,
                    text: `${current.text} ${next.text}`.replace(/\s+/g, ' ').trim()
                };
            } else {
                merged.push(current);
                current = next;
            }
        }

        merged.push(current);
        return merged;
    }

    /**
     * Wrap text to fit within maximum character width AND maximum lines
     * Smart wrapping that respects word boundaries and line limits
     */
    private static wrapText(text: string, maxWidth: number, maxLines: number = 3): string {
        // First try with original maxWidth
        let lines: string[] = [];
        let currentLine = '';
        const words = text.split(/\s+/).filter(w => w.length > 0);

        if (words.length === 0) return '';

        // Break words into lines respecting maxWidth
        for (const word of words) {
            if (currentLine === '') {
                currentLine = word;
            } else if ((currentLine + ' ' + word).length <= maxWidth) {
                currentLine = currentLine + ' ' + word;
            } else {
                lines.push(currentLine);
                currentLine = word;
            }
        }
        if (currentLine) lines.push(currentLine);

        // If more than maxLines, recalculate with larger line width
        if (lines.length > maxLines) {
            // Calculate ideal width for exactly maxLines
            const totalChars = text.replace(/\s+/g, ' ').length;
            let newMaxWidth = Math.ceil(totalChars / maxLines) + 2;

            lines = [];
            currentLine = '';

            for (const word of words) {
                if (currentLine === '') {
                    currentLine = word;
                } else if ((currentLine + ' ' + word).length <= newMaxWidth) {
                    currentLine = currentLine + ' ' + word;
                } else {
                    lines.push(currentLine);
                    currentLine = word;
                }
            }
            if (currentLine) lines.push(currentLine);

            // Force to maxLines if still over
            if (lines.length > maxLines) {
                lines = lines.slice(0, maxLines);
            }
        }

        return lines.join('\\N'); // ASS newline
    }

    /**
     * Calculate maximum characters per line based on font size and video width
     * Accounts for margins and uses empirical values for readable text
     */
    private static calculateMaxLineLength(fontSize: number, videoWidth: number, isPortrait: boolean): number {
        // Empirical formula: approximate chars that fit per pixel width
        // At 70pt font on 1920px width portrait, ~12 chars fit
        // At 56pt font on 1920px width landscape, ~35 chars fit

        if (isPortrait) {
            // Portrait: tighter wrapping, larger font
            const charWidthRatio = 0.008; // pixels per character at baseline
            const usableWidth = videoWidth - 60; // Account for margins (30px each side)
            return Math.max(8, Math.floor(usableWidth * charWidthRatio / (fontSize / 70)));
        } else {
            // Landscape: wider wrapping, smaller font
            const charWidthRatio = 0.012;
            const usableWidth = videoWidth - 30;
            return Math.max(20, Math.floor(usableWidth * charWidthRatio / (fontSize / 56)));
        }
    }

    /**
     * Calculate optimal words per line based on content
     * 'auto' = intelligent calculation based on word lengths
     * number = fixed words per line
     */
    private static calculateWordsPerLine(
        words: string[],
        maxLineLength: number,
        wordsPerLineOption?: number | 'auto'
    ): number {
        if (typeof wordsPerLineOption === 'number') {
            return wordsPerLineOption;
        }

        // Auto mode: calculate based on average word length
        if (wordsPerLineOption === 'auto' || !wordsPerLineOption) {
            const avgWordLength = words.reduce((sum, w) => sum + w.length, 0) / words.length;
            // Add 1 space per word except last
            const avgLineChars = avgWordLength * 2 + 1; // Rough estimate: 2 words + 1 space
            return Math.max(2, Math.floor(maxLineLength / avgLineChars));
        }

        return 4; // Default fallback
    }

    /**
     * Escape regex special characters
     */
    private static escapeRegex(str: string): string {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    /**
     * Escape ASS reserved characters in visible subtitle text
     */
    private static escapeAssText(text: string): string {
        return text
            .replace(/\\/g, '\\\\')
            .replace(/\{/g, '\\{')
            .replace(/\}/g, '\\}')
            .replace(/\r?\n/g, ' ')
            .trim();
    }

    /**
     * Generate ASS subtitle with style and animation support
     */
    static generateASS(
        segments: Array<{ start: number; end: number; text: string }>,
        resolution: string = '1920x1080',
        options: SubtitleOptions = {}
    ): string {
        const [width, height] = resolution.split('x').map(Number);
        const isPortrait = height > width;

        // Resolve options
        const stylePreset = options.stylePreset || 'basic';
        const animationPreset = options.animationPreset || '';
        const maxLinesPerDisplay = options.maxLinesPerDisplay || 3;
        const customStyle = options.customStyle || {};

        // Get style from service
        const styleConfig = StyleService.getStyle(stylePreset);
        const mergedStyle = { ...styleConfig, ...customStyle };

        // Build styles
        const resolution_obj = { width, height };
        const styleString = StyleService.getStyleString(mergedStyle, {}, resolution_obj);

        // Calculate text wrapping
        const fontSize = mergedStyle.size || 70;
        const maxLineLength = this.calculateMaxLineLength(fontSize, width, isPortrait);
        const marginV = mergedStyle.margin_v || (isPortrait ? 80 : 30);
        const marginL = mergedStyle.margin_l || (isPortrait ? 30 : 15);
        const marginR = mergedStyle.margin_r || (isPortrait ? 30 : 15);

        const header = `[Script Info]
Title: Clipper Generated Subtitle
Original Script: Clipper
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${styleString}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

        const events = segments
            .map(seg => {
                const start = this.formatTimeASS(seg.start);
                const end = this.formatTimeASS(seg.end);
                const animation = animationPreset ? AnimationService.getPreset(animationPreset) : '';
                const wrappedText = this.wrapText(seg.text, maxLineLength, maxLinesPerDisplay);
                return `Dialogue: 0,${start},${end},Default,,0,0,0,,${animation}${wrappedText}`;
            })
            .join('\n');

        return header + events;
    }

    /**
     * Format time untuk ASS format (H:MM:SS.CC)
     */
    private static formatTimeASS(seconds: number): string {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = Math.floor(seconds % 60);
        const centisecs = Math.round((seconds % 1) * 100);

        return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(centisecs).padStart(2, '0')}`;
    }

    /**
     * Generate simple SRT subtitle file
     */
    static generateSRT(
        segments: Array<{ start: number; end: number; text: string }>
    ): string {
        return segments
            .map((seg, idx) => {
                const start = this.formatTimeSRT(seg.start);
                const end = this.formatTimeSRT(seg.end);
                return `${idx + 1}\n${start} --> ${end}\n${seg.text}\n`;
            })
            .join('\n');
    }

    /**
     * Format time untuk SRT format (HH:MM:SS,mmm)
     */
    private static formatTimeSRT(seconds: number): string {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = Math.floor(seconds % 60);
        const millis = Math.floor((seconds % 1) * 1000);

        return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
    }
}
