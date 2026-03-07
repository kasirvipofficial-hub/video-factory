import { Queue } from 'bullmq';
import { ENV } from '../config/env';
import {
    defaultClipJobOptions,
    defaultWebhookJobOptions,
    ensureRedisConnected,
    queueConnection
} from './connection';

export interface JobWebhookConfig {
    url: string;
    bearerToken?: string;
    secret?: string;
    events?: string[];
}

export interface ClipFontCustomization {
    family?: string;
    size?: number;
    stylePreset?: string;
}

export interface ClipCustomization {
    postingTone?: string;
    targetPlatform?: 'tiktok' | 'instagram' | 'youtube-shorts' | 'general';
    targetAudience?: string;
    language?: string;
    callToAction?: string;
    captionStyle?: string;
    hashtags?: string[];
    additionalInstructions?: string;
    font?: ClipFontCustomization;
    filters?: string[];
}

export interface ClipJobPayload {
    jobId: string;
    tenantId: string;
    youtubeUrl: string;
    mode: 'auto' | 'discover_only' | 'produce';
    selectionPolicy: 'top1' | 'wait_user' | 'all' | 'auto_best';
    selection?: string[] | 'all' | 'top1' | 'auto_best';
    customization?: ClipCustomization;
    webhook?: JobWebhookConfig;
    triggerReason?: 'initial' | 'selection' | 'timeout_fallback' | 'recovery';
}

export interface RenderJobPayload {
    jobId: string;
    tenantId: string;
    triggerReason?: 'initial' | 'selection' | 'timeout_fallback' | 'recovery';
}

export interface WebhookEventPayload {
    event:
        | 'job.queued'
        | 'job.started'
        | 'job.progress'
        | 'job.awaiting_selection'
        | 'job.completed'
        | 'job.failed';
    jobId: string;
    tenantId: string;
    webhook: JobWebhookConfig;
    payload: Record<string, unknown>;
}

export interface SelectionTimeoutPayload {
    jobId: string;
    tenantId: string;
}

export const clipQueue = new Queue<ClipJobPayload>(ENV.CLIP_QUEUE_NAME, {
    connection: queueConnection(),
    prefix: ENV.REDIS_PREFIX,
    defaultJobOptions: defaultClipJobOptions
});

export const webhookQueue = new Queue<WebhookEventPayload>(ENV.WEBHOOK_QUEUE_NAME, {
    connection: queueConnection(),
    prefix: ENV.REDIS_PREFIX,
    defaultJobOptions: defaultWebhookJobOptions
});

export const renderQueue = new Queue<RenderJobPayload>(ENV.RENDER_QUEUE_NAME, {
    connection: queueConnection(),
    prefix: ENV.REDIS_PREFIX,
    defaultJobOptions: defaultClipJobOptions
});

export const fallbackQueue = new Queue<SelectionTimeoutPayload>(ENV.FALLBACK_QUEUE_NAME, {
    connection: queueConnection(),
    prefix: ENV.REDIS_PREFIX,
    defaultJobOptions: {
        attempts: 1,
        removeOnComplete: 100,
        removeOnFail: 500
    }
});

export async function enqueueClipJob(payload: ClipJobPayload): Promise<void> {
    await ensureRedisConnected();
    const safeReason = (payload.triggerReason || 'initial').replace(/[^a-zA-Z0-9_-]/g, '-');
    const queueJobId = `${payload.jobId}-${safeReason}-${Date.now()}`;
    await clipQueue.add('clip.process', payload, {
        jobId: queueJobId
    });
}

export async function enqueueWebhookEvent(payload: WebhookEventPayload): Promise<void> {
    await ensureRedisConnected();
    await webhookQueue.add('webhook.dispatch', payload);
}

export async function enqueueRenderJob(payload: RenderJobPayload): Promise<void> {
    await ensureRedisConnected();
    const safeReason = (payload.triggerReason || 'initial').replace(/[^a-zA-Z0-9_-]/g, '-');
    const queueJobId = `${payload.jobId}-${safeReason}-render-${Date.now()}`;
    await renderQueue.add('render.process', payload, {
        jobId: queueJobId
    });
}

export async function enqueueSelectionTimeout(payload: SelectionTimeoutPayload, delayMs: number): Promise<void> {
    await ensureRedisConnected();
    await fallbackQueue.add('selection.timeout', payload, {
        delay: delayMs,
        jobId: `selection-timeout-${payload.jobId}`
    });
}
