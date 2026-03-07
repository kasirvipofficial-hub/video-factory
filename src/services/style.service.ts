export interface StyleConfig {
    font?: string;
    size?: number;
    primary_color?: string;
    secondary_color?: string;
    outline_color?: string;
    back_color?: string;
    bold?: number;
    italic?: number;
    outline?: number;
    shadow?: number;
    alignment?: number;
    spacing?: number;
    margin_v?: number;
    margin_l?: number;
    margin_r?: number;
}

const styles: Record<string, StyleConfig> = {
    basic: {
        font: 'Oswald',
        size: 70,
        primary_color: '&H00FFFFFF',
        secondary_color: '&H00FFFFFF',
        outline_color: '&H00000000',
        back_color: '&H80000000',
        bold: 1,
        italic: 0,
        outline: 2,
        shadow: 2,
        alignment: 2,
        margin_v: 80,
        margin_l: 30,
        margin_r: 30
    },
    modern_bold: {
        font: 'Oswald',
        size: 85,
        primary_color: '&H0000FFFF',
        secondary_color: '&H00FFFFFF',
        outline_color: '&H00000000',
        back_color: '&H00000000',
        bold: 1,
        italic: 0,
        outline: 4,
        shadow: 2,
        alignment: 2,
        margin_v: 100,
        margin_l: 40,
        margin_r: 40
    },
    aesthetic_light: {
        font: 'DM Serif Text',
        size: 75,
        primary_color: '&H00E0E0E0',
        secondary_color: '&H00FFFFFF',
        outline_color: '&H00333333',
        back_color: '&H00000000',
        bold: 0,
        italic: 1,
        outline: 2,
        shadow: 1,
        alignment: 2,
        margin_v: 80,
        margin_l: 30,
        margin_r: 30
    },
    gaming_neon: {
        font: 'Limelight',
        size: 90,
        primary_color: '&H00FF00FF',
        secondary_color: '&H00FFFFFF',
        outline_color: '&H00000000',
        back_color: '&H00000000',
        bold: 1,
        italic: 0,
        outline: 5,
        shadow: 3,
        alignment: 2,
        margin_v: 100,
        margin_l: 40,
        margin_r: 40
    },
    cinematic_serif: {
        font: 'DM Serif Text',
        size: 80,
        primary_color: '&H00FFFFFF',
        secondary_color: '&H00FFFFFF',
        outline_color: '&H00000000',
        back_color: '&H00000000',
        bold: 0,
        italic: 0,
        outline: 2,
        shadow: 2,
        alignment: 2,
        spacing: 2,
        margin_v: 80,
        margin_l: 30,
        margin_r: 30
    },
    karaoke_yellow: {
        font: 'Katibeh',
        size: 70,
        primary_color: '&H00FFFF',  // Yellow (active word default)
        secondary_color: '&H00FFFFFF',
        outline_color: '&H00000000',
        back_color: '&H00000000',
        bold: 1,
        italic: 0,
        outline: 2,
        shadow: 2,
        alignment: 2,
        margin_v: 80,
        margin_l: 30,
        margin_r: 30
    }
};

export class StyleService {
    /**
     * Get ASS style string from preset or custom config
     */
    static getStyleString(
        nameOrConfig: string | StyleConfig | undefined,
        overrides: StyleConfig = {},
        resolution?: { width: number; height: number }
    ): string {
        let base = styles.basic;

        if (typeof nameOrConfig === 'string') {
            // Try to get preset, fallback to basic if not found
            base = styles[nameOrConfig] || styles.basic;
        } else if (typeof nameOrConfig === 'object' && nameOrConfig !== null) {
            base = nameOrConfig;
        }

        // Merge with overrides
        const final = { ...base, ...overrides };

        // Scale font size if resolution provided
        if (resolution && final.size) {
            final.size = Math.round((resolution.height / 1920) * final.size);
        }

        // ASS Style Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
        return `Style: Default,${final.font || 'Oswald'},${final.size || 70},${final.primary_color || '&H00FFFFFF'},${final.secondary_color || '&H000000FF'},${final.outline_color || '&H00000000'},${final.back_color || '&H80000000'},${final.bold || 0},${final.italic || 0},0,0,100,100,${final.spacing || 0},0,1,${final.outline || 2},${final.shadow || 0},${final.alignment || 2},${final.margin_l || 40},${final.margin_r || 40},${final.margin_v || 80},1`;
    }

    /**
     * Get a highlight style variant with different color
     */
    static getHighlightStyle(
        styleString: string,
        highlightColor: string = '&H0000FFFF',
        styleName: string = 'Highlight'
    ): string {
        return styleString
            .replace('Style: Default', `Style: ${styleName}`)
            .replace(/(&H[0-9A-Fa-f]{8}),(&H[0-9A-Fa-f]{8})/, `${highlightColor},${highlightColor}`);
    }

    /**
     * Get all available style presets
     */
    static getAvailableStyles(): string[] {
        return Object.keys(styles);
    }

    /**
     * Get style config by name
     */
    static getStyle(name: string): StyleConfig {
        return styles[name] || styles.basic;
    }

    /**
     * Register custom style preset
     */
    static registerCustomStyle(name: string, config: StyleConfig): void {
        styles[name] = config;
    }
}
