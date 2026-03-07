import IORedis from 'ioredis';
import { JobsOptions } from 'bullmq';
import { ENV } from '../config/env';
import { log } from '../utils/logger';

export const redis = new IORedis(ENV.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: true
});

let wired = false;

export function wireRedisLogging(): void {
    if (wired) return;
    wired = true;

    redis.on('connect', () => log.info({ redis: ENV.REDIS_URL }, '[REDIS] Connected'));
    redis.on('ready', () => log.info('[REDIS] Ready'));
    redis.on('error', (err) => log.error({ err: err.message }, '[REDIS] Error'));
    redis.on('reconnecting', () => log.warn('[REDIS] Reconnecting...'));
}

export async function ensureRedisConnected(): Promise<void> {
    wireRedisLogging();
    if (redis.status === 'ready' || redis.status === 'connect') return;
    await redis.connect();
}

export function queueConnection() {
    return {
        url: ENV.REDIS_URL
    };
}

export const defaultClipJobOptions: JobsOptions = {
    attempts: 2,
    backoff: {
        type: 'exponential',
        delay: 5000
    },
    removeOnComplete: 100,
    removeOnFail: 500
};

export const defaultWebhookJobOptions: JobsOptions = {
    attempts: ENV.WEBHOOK_MAX_RETRIES,
    backoff: {
        type: 'exponential',
        delay: 2000
    },
    removeOnComplete: 200,
    removeOnFail: 1000
};
