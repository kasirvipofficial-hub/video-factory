import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import fs from 'fs';
import { log } from '../utils/logger';
import { ENV } from '../config/env';

export class S3Service {
    private static async withTimeout<T>(promise: Promise<T>, timeoutMs: number, description: string): Promise<T> {
        let timeoutHandle: NodeJS.Timeout | undefined;

        try {
            return await Promise.race([
                promise,
                new Promise<T>((_, reject) => {
                    timeoutHandle = setTimeout(() => reject(new Error(`${description} timed out after ${timeoutMs}ms`)), timeoutMs);
                })
            ]);
        } finally {
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
            }
        }
    }

    private static assertConfigured(): void {
        const required = ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY', 'S3_SECRET_KEY', 'S3_PUBLIC_URL'] as const;
        const missing = required.filter((key) => !ENV[key]);

        if (missing.length > 0) {
            throw new Error(`Missing S3 configuration: ${missing.join(', ')}`);
        }
    }

    private static getClient(): S3Client {
        this.assertConfigured();
        return new S3Client({
            region: ENV.S3_REGION,
            endpoint: ENV.S3_ENDPOINT,
            credentials: {
                accessKeyId: ENV.S3_ACCESS_KEY,
                secretAccessKey: ENV.S3_SECRET_KEY,
            },
            // Cloudflare R2 specific settings:
            forcePathStyle: true,
        });
    }

    /**
     * Uploads a file to the S3 bucket and returns the public URL.
     * @param localFilePath Absolute path to the file to be uploaded.
     * @param destPath Prefix/Folder structure inside the bucket (e.g. 'ytdl/file.mp4')
     */
    static async uploadFile(localFilePath: string, destPath: string): Promise<string> {
        log.info({ localFilePath, destPath }, '[S3] Starting file upload');

        const client = this.getClient();

        // Basic content type detection based on extension
        let contentType = 'application/octet-stream';
        if (destPath.endsWith('.mp4')) contentType = 'video/mp4';
        else if (destPath.endsWith('.mp3')) contentType = 'audio/mpeg';
        else if (destPath.endsWith('.jpg') || destPath.endsWith('.jpeg')) contentType = 'image/jpeg';
        else if (destPath.endsWith('.png')) contentType = 'image/png';
        else if (destPath.endsWith('.json')) contentType = 'application/json';
        else if (destPath.endsWith('.md')) contentType = 'text/markdown; charset=utf-8';
        else if (destPath.endsWith('.ass') || destPath.endsWith('.srt')) contentType = 'text/plain; charset=utf-8';

        const maxAttempts = Math.max(1, ENV.S3_UPLOAD_MAX_RETRIES);
        let lastError: Error | undefined;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const fileStream = fs.createReadStream(localFilePath);

            try {
                const command = new PutObjectCommand({
                    Bucket: ENV.S3_BUCKET,
                    Key: destPath,
                    Body: fileStream,
                    ContentType: contentType,
                });

                await this.withTimeout(
                    client.send(command),
                    ENV.S3_UPLOAD_TIMEOUT_MS,
                    `S3 upload for ${destPath}`
                );

                const publicUrl = `${ENV.S3_PUBLIC_URL}/${destPath}`;
                log.info({ publicUrl, destPath, attempt }, '[SUCCESS] File uploaded to S3');
                return publicUrl;
            } catch (error: any) {
                lastError = error instanceof Error ? error : new Error(String(error));
                log.warn({ err: lastError.message, destPath, attempt, maxAttempts }, '[S3] Upload attempt failed');
                fileStream.destroy();
            }
        }

        log.error({ err: lastError?.message, destPath, maxAttempts }, '[ERROR] S3 upload failed');
        throw lastError || new Error(`S3 upload failed for ${destPath}`);
    }
}
