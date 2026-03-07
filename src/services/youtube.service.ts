import { execSync, spawnSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { log } from '../utils/logger';
import { ENV } from '../config/env';

export interface VideoInfo {
    videoId: string;
    title: string;
    duration: number;
    url: string;
}

export class YouTubeService {
    static async getVideoInfo(url: string): Promise<VideoInfo> {
        try {
            const infoOutput = execSync(`${ENV.YT_DLP_PATH} -j "${url}"`, {
                encoding: 'utf8',
                cwd: process.cwd()
            });
            const data = JSON.parse(infoOutput);
            return {
                videoId: data.id || 'unknown',
                title: data.title || data.fulltitle || 'untitled',
                duration: data.duration || 0,
                url
            };
        } catch (err: any) {
            log.warn({ err: err.message, url }, 'Could not fetch YouTube metadata, using fallback info');
            return {
                videoId: 'unknown',
                title: 'unknown',
                duration: 0,
                url
            };
        }
    }

    /**
     * Download video dari YouTube ke file lokal
     */
    static async download(url: string, outputDir: string): Promise<{ filePath: string; info: VideoInfo }> {
        log.info({ url }, '📺 Starting YouTube download');

        try {
            // Create output directory
            if (!fs.existsSync(outputDir)) {
                fs.mkdirSync(outputDir, { recursive: true });
            }

            const outputTemplate = path.join(outputDir, '%(title)s.%(ext)s');

            // Build yt-dlp command
            const args = [
                url,
                '-f', 'best[ext=mp4]',
                '-o', outputTemplate,
                '--quiet',
                '--no-warnings'
            ];

            // Add cookies if available
            if (fs.existsSync(ENV.COOKIES_FILE)) {
                args.push('--cookies', ENV.COOKIES_FILE);
            }

            log.info({ args }, 'Executing yt-dlp command');

            // Execute download using spawnSync to handle better
            try {
                const result = execSync(`${ENV.YT_DLP_PATH} ${args.map(a => `"${a}"`).join(' ')}`, {
                    encoding: 'utf8',
                    cwd: process.cwd(),
                    stdio: ['pipe', 'pipe', 'pipe']
                });
                log.info('yt-dlp executed successfully');
            } catch (err: any) {
                log.warn({ msg: 'yt-dlp command error', error: err.message });
            }

            // Wait a bit for file to be written
            await new Promise(resolve => setTimeout(resolve, 2000));

            // Find downloaded file
            const files = fs.readdirSync(outputDir).filter(f => f.endsWith('.mp4'));
            
            if (files.length === 0) {
                // Check jika ada file lain
                const allFiles = fs.readdirSync(outputDir);
                log.info({ allFiles }, 'Files in output directory');
                throw new Error(`No MP4 file found. Files: ${allFiles.join(', ')}`);
            }

            const filePath = path.join(outputDir, files[0]);
            const fileSize = fs.statSync(filePath).size;

            log.info({ filePath, fileSize }, '✅ Download complete');

            // Get video info using yt-dlp with JSON output
            let videoData: any = {
                id: 'unknown',
                title: files[0].replace('.mp4', ''),
                duration: 0
            };

            try {
                const infoOutput = execSync(`${ENV.YT_DLP_PATH} -j "${url}"`, {
                    encoding: 'utf8',
                    cwd: process.cwd()
                });
                videoData = JSON.parse(infoOutput);
            } catch (err: any) {
                log.warn({ msg: 'Could not get video info from yt-dlp', error: err.message });
            }

            const info: VideoInfo = {
                videoId: videoData.id || 'unknown',
                title: videoData.title || videoData.fulltitle || files[0],
                duration: videoData.duration || 0,
                url: url
            };

            return { filePath, info };

        } catch (err: any) {
            log.error({ err: err.message }, '❌ Download failed');
            throw err;
        }
    }
}
