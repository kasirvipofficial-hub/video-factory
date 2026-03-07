/**
 * FilterService - FFmpeg video filter presets
 * Reference: https://ffmpeg.org/ffmpeg-filters.html
 */

export class FilterService {
    /**
     * Map of filter names to FFmpeg filter strings
     * These can be combined with -vf (video filter) in FFmpeg commands
     */
    private static filters: Record<string, string> = {
        // Color effects
        vignette: 'vignette=PI/4',
        sepia: 'colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131',
        grayscale: 'colorchannelmixer=.3:.4:.3:0:.3:.4:.3:0:.3:.4:.3',
        dramatic: 'curves=all=\'0/0 0.5/0.4 1/1\',unsharp=5:5:1.0:5:5:0.0',
        vintage: 'curves=vintage,noise=alls=10:allf=t+u',
        warm: 'curves=all=\'0/0 0.5/0.55 1/1\',hue=h=0:s=1.2:b=0',
        cold: 'curves=all=\'0/0 0.5/0.45 1/1\',hue=h=0:s=0.8:b=0',
        bright: 'eq=brightness=0.1:contrast=1.1',
        dark: 'eq=brightness=-0.1:contrast=1.2',
        
        // Texture/Grain effects
        grain: 'noise=alls=20:allf=t+u',
        film_grain: 'noise=alls=15:allf=t+u',
        
        // Enhancement
        hdr: 'hqdn3d=1.5:1.5:6:6,unsharp=5:5:0.5:5:5:0.0',
        sharpen: 'unsharp=5:5:1.0:5:5:1.0',
        denoise: 'hqdn3d=1.5:1.5:6:6',
        
        // Blur effects
        blur: 'boxblur=2:1',
        motion_blur: 'boxblur=10:1',
        
        // Exposure/Levels
        increase_saturation: 'hue=s=1.5',
        decrease_saturation: 'hue=s=0.5',
        increase_contrast: 'eq=contrast=1.5',
        
        // Special effects
        invert: 'negate',
        mirror_horizontal: 'hflip',
        mirror_vertical: 'vflip',
        
        // Speed/Time (these should be used with -filter-complex)
        // slow_motion: 'setpts=2*PTS',
        // fast_forward: 'setpts=0.5*PTS'
    };

    /**
     * Get the FFmpeg filter string for a given preset
     * @param name - Filter preset name
     * @returns FFmpeg filter string
     */
    static getFilter(name: string): string {
        return this.filters[name.toLowerCase()] || '';
    }

    /**
     * Get all available filter names
     */
    static getAvailableFilters(): string[] {
        return Object.keys(this.filters);
    }

    /**
     * Combine multiple filters into a single filter chain
     * @param filterNames - Array of filter names
     * @returns Combined FFmpeg filter string
     */
    static combineFilters(...filterNames: string[]): string {
        return filterNames
            .map(name => this.getFilter(name))
            .filter(filter => filter.length > 0)
            .join(',');
    }

    /**
     * Check if a filter exists
     */
    static filterExists(name: string): boolean {
        return name.toLowerCase() in this.filters;
    }

    /**
     * Register custom filter preset
     * @param name - Filter name
     * @param ffmpegFilterString - FFmpeg filter string
     */
    static registerCustomFilter(name: string, ffmpegFilterString: string): void {
        this.filters[name.toLowerCase()] = ffmpegFilterString;
    }

    /**
     * Get description of what a filter does
     */
    static getFilterDescription(name: string): string {
        const descriptions: Record<string, string> = {
            vignette: 'Darkens edges of the video',
            sepia: 'Adds warm brownish tone (vintage look)',
            grayscale: 'Converts to black and white',
            dramatic: 'Increases contrast dramatically',
            vintage: 'Vintage film look with grain',
            warm: 'Adds warm orange/yellow tint',
            cold: 'Adds cool blue tint',
            bright: 'Increases brightness and contrast',
            dark: 'Decreases brightness, increases contrast',
            grain: 'Adds film grain for nostalgic feel',
            film_grain: 'Adds cinematic film grain',
            hdr: 'HDR-like high dynamic range processing',
            sharpen: 'Increases sharpness and details',
            denoise: 'Reduces noise while keeping details',
            blur: 'Applies subtle blur',
            motion_blur: 'Creates motion blur effect',
            increase_saturation: 'Makes colors more vivid',
            decrease_saturation: 'Makes colors more muted',
            increase_contrast: 'Increases difference between light/dark',
            invert: 'Inverts all colors (negative)',
            mirror_horizontal: 'Flips video left-to-right',
            mirror_vertical: 'Flips video top-to-bottom'
        };

        return descriptions[name.toLowerCase()] || 'Unknown filter';
    }
}
