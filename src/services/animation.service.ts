/**
 * AnimationService - ASS animation presets for karaoke and subtitle effects
 * Reference: https://en.wikibooks.org/wiki/ASS_Tags
 */

export interface AnimationConfig {
    duration: number;
    start: string;
    end: string;
}

export class AnimationService {
    /**
     * Slide Up with Fade - Text slides up with fade in/out
     */
    static slideUp(durationMs: number = 500, resolution?: { width: number; height: number }): string {
        return `{\\fad(200,200)}`;
    }

    /**
     * Bounce entrance from bottom - Text bounces from bottom with movement
     */
    static slideUpBounce(durationMs: number = 500, resolution?: { width: number; height: number }): string {
        const duration = Math.ceil(durationMs / 1000 * 100); // Convert to ASS time format
        return `{\\fad(100,100)\\t(0,${duration},\\fscx95\\fscy95)}`;
    }

    /**
     * Zoom In (Pop) - Text zooms in from small to normal size
     */
    static zoomIn(durationMs: number = 500, resolution?: { width: number; height: number }): string {
        const duration = Math.ceil(durationMs / 1000 * 100);
        return `{\\t(0,${duration},\\fscx100\\fscy100)}`;
    }

    /**
     * Flash highlight - Text flashes/blinks
     */
    static flash(durationMs: number = 500, resolution?: { width: number; height: number }): string {
        const duration = Math.ceil(durationMs / 1000 * 100);
        return `{\\t(0,${duration / 2},\\1c&HFFFFFF&)\\t(${duration / 2},${duration},\\1c&H00FFFF&)}`;
    }

    /**
     * Fade in/out - Simple fade effect
     */
    static fadeInOut(durationMs: number = 500, resolution?: { width: number; height: number }): string {
        return `{\\fad(${Math.ceil(durationMs / 2)},${Math.ceil(durationMs / 2)})}`;
    }

    /**
     * Glow effect - Text glows with color change
     */
    static glow(durationMs: number = 500, resolution?: { width: number; height: number }): string {
        const duration = Math.ceil(durationMs / 1000 * 100);
        return `{\\c&H00FFFF&\\t(0,${duration},\\c&HFFFFFF&)}`;
    }

    /**
     * Pulse effect - Text pulsates in size
     */
    static pulse(durationMs: number = 500, resolution?: { width: number; height: number }): string {
        const duration = Math.ceil(durationMs / 1000 * 100);
        return `{\\t(0,${duration / 2},\\fscx110\\fscy110)\\t(${duration / 2},${duration},\\fscx100\\fscy100)}`;
    }

    /**
     * Rotate effect - Text rotates
     */
    static rotate(durationMs: number = 500, resolution?: { width: number; height: number }): string {
        const duration = Math.ceil(durationMs / 1000 * 100);
        return `{\\frz0\\t(0,${duration},\\frz360)}`;
    }

    /**
     * Wave effect - Text moves horizontally in a wave
     */
    static wave(durationMs: number = 500, resolution?: { width: number; height: number }): string {
        const duration = Math.ceil(durationMs / 1000 * 100);
        return `{\\t(0,${duration / 2},\\c&H00FFFF&)\\t(${duration / 2},${duration},\\c&HFFFFFF&)}`;
    }

    /**
     * Get preset animation by name
     */
    static getPreset(name: string, durationMs: number = 500, resolution?: { width: number; height: number }): string {
        switch (name.toLowerCase()) {
            case 'slide_up':
                return this.slideUp(durationMs, resolution);
            case 'slide_up_bounce':
                return this.slideUpBounce(durationMs, resolution);
            case 'zoom_in':
                return this.zoomIn(durationMs, resolution);
            case 'flash':
                return this.flash(durationMs, resolution);
            case 'fade_inout':
                return this.fadeInOut(durationMs, resolution);
            case 'glow':
                return this.glow(durationMs, resolution);
            case 'pulse':
                return this.pulse(durationMs, resolution);
            case 'rotate':
                return this.rotate(durationMs, resolution);
            case 'wave':
                return this.wave(durationMs, resolution);
            default:
                return ''; // No animation
        }
    }

    /**
     * Get all available animation presets
     */
    static getAvailablePresets(): string[] {
        return [
            'slide_up',
            'slide_up_bounce',
            'zoom_in',
            'flash',
            'fade_inout',
            'glow',
            'pulse',
            'rotate',
            'wave'
        ];
    }

    /**
     * Combine multiple animations
     */
    static combine(...animations: string[]): string {
        return animations.filter(a => a.length > 0).join('');
    }
}
