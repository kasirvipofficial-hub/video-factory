import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import fs from 'fs';
import path from 'path';
import { log } from '../utils/logger';
import { ENV } from '../config/env';

export class S3Service {
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

        try {
            const client = this.getClient();
            const fileStream = fs.createReadStream(localFilePath);

            // Basic content type detection based on extension
            let contentType = 'application/octet-stream';
            if (destPath.endsWith('.mp4')) contentType = 'video/mp4';
            else if (destPath.endsWith('.mp3')) contentType = 'audio/mpeg';
            else if (destPath.endsWith('.jpg') || destPath.endsWith('.jpeg')) contentType = 'image/jpeg';
            else if (destPath.endsWith('.png')) contentType = 'image/png';
            else if (destPath.endsWith('.json')) contentType = 'application/json';
            else if (destPath.endsWith('.md')) contentType = 'text/markdown; charset=utf-8';
            else if (destPath.endsWith('.ass') || destPath.endsWith('.srt')) contentType = 'text/plain; charset=utf-8';

            const command = new PutObjectCommand({
                Bucket: ENV.S3_BUCKET,
                Key: destPath,
                Body: fileStream,
                ContentType: contentType,
            });

            await client.send(command);

            const publicUrl = `${ENV.S3_PUBLIC_URL}/${destPath}`;
            log.info({ publicUrl }, '[SUCCESS] File uploaded to S3');
            return publicUrl;

        } catch (error: any) {
            log.error({ err: error.message, destPath }, '[ERROR] S3 upload failed');
            throw error;
        }
    }
}
