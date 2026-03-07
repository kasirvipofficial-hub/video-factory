// Example: Using the new adopted services with subtitles

import { SubtitleService, SubtitleOptions } from '../services/subtitle.service';
import { StyleService } from '../services/style.service';
import { AnimationService } from '../services/animation.service';
import { FilterService } from '../services/filter.service';
import { MusicService } from '../services/music.service';

/**
 * EXAMPLE 1: Karaoke with custom style and animation
 */
async function exampleKaraokeWithStyles() {
    const subtitleSegments = [
        { start: 0, end: 5.5, text: 'Hello world, welcome to clipper' },
        { start: 5.5, end: 11, text: 'This is amazing subtitle technology' }
    ];

    const options: SubtitleOptions = {
        stylePreset: 'modern_bold',      // Use modern bold style
        animationPreset: 'zoom_in',      // Add zoom animation
        maxLinesPerDisplay: 3,           // Max 3 lines per display
        wordsPerLine: 'auto'             // Smart word wrapping
    };

    const assContent = SubtitleService.generateKaraokeASS(
        subtitleSegments,
        '1080x1920', // Portrait resolution
        options
    );

    console.log('✨ Karaoke ASS generated with modern_bold style and zoom animation');
    // Save to file, apply to video, etc.
}

/**
 * EXAMPLE 2: Regular subtitles with aesthetic style
 */
async function exampleSubtitleWithStyle() {
    const subtitleSegments = [
        { start: 0, end: 3, text: 'Beautiful aesthetics' },
        { start: 3, end: 6, text: 'With light text styling' }
    ];

    const options: SubtitleOptions = {
        stylePreset: 'aesthetic_light',  // Light, modern style
        animationPreset: 'fade_inout',   // Fade animation
        maxLinesPerDisplay: 3
    };

    const assContent = SubtitleService.generateASS(
        subtitleSegments,
        '1920x1080',
        options
    );

    console.log('📝 Subtitle generated with aesthetic_light style');
}

/**
 * EXAMPLE 3: Using custom style override
 */
async function exampleCustomStyle() {
    const subtitleSegments = [
        { start: 0, end: 5, text: 'Custom neon gaming style' }
    ];

    const options: SubtitleOptions = {
        stylePreset: 'gaming_neon',      // Start with gaming style
        customStyle: {
            size: 100,                    // Override font size
            primary_color: '&H00FF00FF'   // Override to magenta
        },
        animationPreset: 'glow'          // Glowing effect
    };

    const assContent = SubtitleService.generateKaraokeASS(
        subtitleSegments,
        '1080x1920',
        options
    );

    console.log('🎮 Custom neon gaming subtitle with glow effect');
}

/**
 * EXAMPLE 4: Available style presets
 */
function showAvailableStyles() {
    const styles = StyleService.getAvailableStyles();
    console.log('Available style presets:');
    styles.forEach(style => {
        const config = StyleService.getStyle(style);
        console.log(`  • ${style}: ${config.font} @ ${config.size}pt, Color: ${config.primary_color}`);
    });
}

/**
 * EXAMPLE 5: Available animation presets
 */
function showAvailableAnimations() {
    const animations = AnimationService.getAvailablePresets();
    console.log('Available animation presets:');
    animations.forEach(anim => {
        console.log(`  • ${anim}`);
    });
}

/**
 * EXAMPLE 6: Using video filters
 */
function exampleVideoFilters() {
    // Get single filter
    const vignetteFilter = FilterService.getFilter('vignette');
    console.log('Vignette filter:', vignetteFilter);

    // Combine multiple filters
    const combinedFilters = FilterService.combineFilters('warm', 'sharpen');
    console.log('Combined filters:', combinedFilters);

    // Use in FFmpeg command
    const ffmpegCmd = `ffmpeg -i input.mp4 -vf "${combinedFilters}" output.mp4`;

    // List all available filters with descriptions
    const allFilters = FilterService.getAvailableFilters();
    allFilters.forEach(filterName => {
        const description = FilterService.getFilterDescription(filterName);
        console.log(`  • ${filterName}: ${description}`);
    });
}

/**
 * EXAMPLE 7: Search for background music with Deezer
 */
async function exampleMusicSearch() {
    try {
        // Search for specific music
        const result = await MusicService.searchMusic('uplifting electronic');
        console.log('Found music:', {
            title: result.title,
            artist: result.artist,
            url: result.url,
            duration: result.duration
        });

        // Get by genre
        const genreMusic = await MusicService.getByGenre('lo-fi hip hop');
        console.log('Genre music:', genreMusic.title);

        // Get by artist
        const artistMusic = await MusicService.getByArtist('Dua Lipa');
        console.log('Artist music:', artistMusic.title);

        // Get trending
        const trendy = await MusicService.getTrending();
        console.log('Trending:', trendy.title);
    } catch (error) {
        console.error('Music search failed:', error);
    }
}

/**
 * EXAMPLE 8: Complete workflow combining all new services
 */
async function exampleCompleteWorkflow() {
    // 1. Prepare subtitle segments
    const subtitles = [
        { start: 0, end: 3, text: 'Amazing content' },
        { start: 3, end: 6, text: 'With perfect styling' },
        { start: 6, end: 9, text: 'And smooth animations' }
    ];

    // 2. Create subtitle with professional style
    const options: SubtitleOptions = {
        stylePreset: 'cinematic_serif',
        animationPreset: 'slide_up',
        maxLinesPerDisplay: 3,
        wordsPerLine: 'auto'
    };

    const assContent = SubtitleService.generateKaraokeASS(
        subtitles,
        '1080x1920',
        options
    );

    // 3. Get background music
    const music = await MusicService.searchMusic('cinematic background');
    console.log(`Using music: ${music.title} by ${music.artist}`);

    // 4. Apply video filters
    const filterChain = FilterService.combineFilters('warm', 'sharpen');
    console.log(`Applying filters: ${filterChain}`);

    // Build FFmpeg command with everything
    const ffmpegCommand = `
        ffmpeg -i input.mp4 \\
            -i music.mp3 \\
            -vf "${filterChain}" \\
            -c:a aac \\
            -filter_complex "[0:a][1:a]amerge=inputs=2[a]" \\
            -map 0:v -map "[a]" \\
            ./assets_video.mp4
    `;

    console.log('Complete workflow ready for processing!');
}

// Export examples for testing
export {
    exampleKaraokeWithStyles,
    exampleSubtitleWithStyle,
    exampleCustomStyle,
    showAvailableStyles,
    showAvailableAnimations,
    exampleVideoFilters,
    exampleMusicSearch,
    exampleCompleteWorkflow
};
