import { log } from '../utils/logger';

/**
 * Music search result from stock music provider
 */
export interface MusicSearchResult {
    url: string;
    duration?: number;
    provider: string;
    title?: string;
    artist?: string;
    id?: string;
}

/**
 * MusicService - Search and retrieve background music from various providers
 * Primary: Deezer API for stock music discovery
 */
export class MusicService {
    /**
     * Search for background music on Deezer
     * @param query - Search query (song name, artist, genre, etc.)
     * @param options - Search options (limit, language, etc.)
     * @returns Music search result with URL and metadata
     */
    static async searchDeezer(query: string, options: any = {}): Promise<MusicSearchResult> {
        try {
            const limit = options.limit || 15;
            const params = new URLSearchParams({
                q: query,
                limit: limit.toString()
            });

            log.info({ query, provider: 'deezer' }, 'Searching music on Deezer');

            const res = await fetch(`https://api.deezer.com/search/track?${params}`);
            if (!res.ok) {
                throw new Error(`Deezer HTTP ${res.status}: ${res.statusText}`);
            }

            const data: any = await res.json();

            if (!data.data || !Array.isArray(data.data) || data.data.length === 0) {
                throw new Error(`No music results found for query: "${query}"`);
            }

            // Select random track from results to provide variety
            const randomIndex = Math.floor(Math.random() * data.data.length);
            const track = data.data[randomIndex];

            // Validate track has preview
            if (!track.preview) {
                throw new Error(`Selected track has no preview available: ${track.title}`);
            }

            log.info(
                {
                    title: track.title,
                    artist: track.artist?.name,
                    duration: track.duration
                },
                'Deezer music found'
            );

            return {
                url: track.preview,
                duration: track.duration || 30, // Deezer previews are typically 30 seconds
                provider: 'deezer',
                title: track.title,
                artist: track.artist?.name,
                id: track.id?.toString()
            };
        } catch (err: any) {
            log.error(
                {
                    query,
                    error: err.message,
                    provider: 'deezer'
                },
                'Deezer music search failed'
            );
            throw err;
        }
    }

    /**
     * Search music with multiple providers with fallback
     * Primary: Deezer
     * Fallback: Additional providers can be added here
     */
    static async searchMusic(query: string, options: any = {}): Promise<MusicSearchResult> {
        const providers = ['deezer'];
        let lastErr: Error | null = null;

        for (const provider of providers) {
            try {
                if (provider === 'deezer') {
                    return await this.searchDeezer(query, options);
                }
            } catch (err: any) {
                lastErr = err;
                log.warn({ provider, error: err.message }, `Provider ${provider} failed, trying next...`);
            }
        }

        // If all providers fail, throw the last error
        throw new Error(`All music providers failed. Last error: ${lastErr?.message}`);
    }

    /**
     * Get music recommendations based on genre
     * @param genre - Music genre (pop, rock, hip-hop, ambient, etc.)
     * @param options - Search options
     */
    static async getByGenre(genre: string, options: any = {}): Promise<MusicSearchResult> {
        return this.searchDeezer(genre, options);
    }

    /**
     * Get music by artist
     * @param artist - Artist name
     * @param options - Search options
     */
    static async getByArtist(artist: string, options: any = {}): Promise<MusicSearchResult> {
        return this.searchDeezer(`artist:"${artist}"`, options);
    }

    /**
     * Get trending/popular music
     * This searches for trending tracks - Deezer doesn't have dedicated trending API
     * so we use generic trending queries
     */
    static async getTrending(options: any = {}): Promise<MusicSearchResult> {
        const trendingQueries = ['top songs', 'trending', 'popular music', 'hit songs'];
        const query = trendingQueries[Math.floor(Math.random() * trendingQueries.length)];
        return this.searchDeezer(query, options);
    }

    /**
     * Check if a URL is from a valid music provider
     */
    static isValidMusicUrl(url: string): boolean {
        return url.includes('cdns-files') || // Deezer
               url.includes('cdn-preview') ||
               url.includes('streaming.com');
    }

    /**
     * Validate music search result
     */
    static validateResult(result: MusicSearchResult): boolean {
        return !!(result && result.url && this.isValidMusicUrl(result.url));
    }
}
