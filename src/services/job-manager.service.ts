import { createHash } from 'crypto';
import { ENV } from '../config/env';
import { ensureRedisConnected, redis } from '../queue/connection';
import { ClipCustomization, enqueueWebhookEvent, JobWebhookConfig } from '../queue/queues';
import { log } from '../utils/logger';

export type JobStatus =
    | 'pending'
    | 'queued'
    | 'downloading'
    | 'extracting_audio'
    | 'transcribing'
    | 'analyzing'
    | 'awaiting_selection'
    | 'cutting'
    | 'analyzing_faces'
    | 'converting_format'
    | 'rendering'
    | 'completed'
    | 'failed';

export interface TopicCandidate {
    topicId: string;
    start: number;
    end: number;
    summary: string;
    scoreViral: number;
    reasons: string[];
    confidence: number;
}

export interface JobState {
    jobId: string;
    tenantId: string;
    status: JobStatus;
    progress: number;
    stage: string;
    message: string;
    sourceUrl: string;
    mode: 'auto' | 'discover_only' | 'produce';
    selectionPolicy: 'top1' | 'wait_user' | 'all' | 'auto_best';
    topicCandidates: TopicCandidate[];
    selection?: string[] | 'all' | 'top1' | 'auto_best';
    customization?: ClipCustomization;
    webhook?: JobWebhookConfig;
    artifacts?: any;
    result?: any;
    error?: string;
    attempt: number;
    createdAt: string;
    updatedAt: string;
}

export interface CreateJobParams {
    jobId: string;
    tenantId: string;
    sourceUrl: string;
    mode: 'auto' | 'discover_only' | 'produce';
    selectionPolicy: 'top1' | 'wait_user' | 'all' | 'auto_best';
    customization?: ClipCustomization;
    webhook?: JobWebhookConfig;
}

export class JobManager {
    private static keyJob(jobId: string): string {
        return `${ENV.REDIS_PREFIX}:job:${jobId}`;
    }

    private static keyUrlLock(tenantId: string, url: string): string {
        const safeUrl = typeof url === 'string' ? url : '';
        const urlHash = createHash('sha256').update(safeUrl).digest('hex');
        return `${ENV.REDIS_PREFIX}:job:url:${tenantId}:${urlHash}`;
    }

    private static keyIdempotency(tenantId: string, key: string): string {
        return `${ENV.REDIS_PREFIX}:job:idempotency:${tenantId}:${key}`;
    }

    private static keySelectionTimeout(jobId: string): string {
        return `${ENV.REDIS_PREFIX}:job:selection-timeout:${jobId}`;
    }

    private static normalizeJob(raw: unknown): JobState {
        const data = raw as any;
        return {
            jobId: data.jobId,
            tenantId: data.tenantId || ENV.DEFAULT_TENANT_ID,
            status: data.status || 'queued',
            progress: typeof data.progress === 'number' ? data.progress : 0,
            stage: data.stage || data.status || 'queued',
            message: data.message || 'Job state restored',
            sourceUrl: data.sourceUrl || data.youtubeUrl || '',
            mode: data.mode || 'auto',
            selectionPolicy: data.selectionPolicy || 'all',
            topicCandidates: Array.isArray(data.topicCandidates) ? data.topicCandidates : [],
            selection: data.selection,
            customization: data.customization,
            webhook: data.webhook || (data.webhookUrl ? { url: data.webhookUrl } : undefined),
            artifacts: data.artifacts,
            result: data.result,
            error: data.error,
            attempt: typeof data.attempt === 'number' ? data.attempt : 0,
            createdAt: data.createdAt || new Date().toISOString(),
            updatedAt: data.updatedAt || new Date().toISOString()
        };
    }

    static isTerminal(status: JobStatus): boolean {
        return status === 'completed' || status === 'failed';
    }

    static async createJob(params: CreateJobParams): Promise<JobState> {
        await ensureRedisConnected();
        const now = new Date().toISOString();

        const job: JobState = {
            jobId: params.jobId,
            tenantId: params.tenantId,
            status: 'queued',
            progress: 0,
            stage: 'queued',
            message: 'Job queued',
            sourceUrl: params.sourceUrl,
            mode: params.mode,
            selectionPolicy: params.selectionPolicy,
            topicCandidates: [],
            customization: params.customization,
            webhook: params.webhook,
            attempt: 0,
            createdAt: now,
            updatedAt: now
        };

        await redis.set(this.keyJob(job.jobId), JSON.stringify(job));
        await redis.set(this.keyUrlLock(job.tenantId, job.sourceUrl), job.jobId, 'EX', 60 * 60 * 12);

        log.info({ jobId: job.jobId, tenantId: job.tenantId, mode: job.mode }, 'Job created');
        return job;
    }

    static async getJob(jobId: string): Promise<JobState | undefined> {
        await ensureRedisConnected();
        const raw = await redis.get(this.keyJob(jobId));
        if (!raw) return undefined;
        return this.normalizeJob(JSON.parse(raw));
    }

    static async updateJob(jobId: string, updates: Partial<JobState>): Promise<JobState | undefined> {
        await ensureRedisConnected();
        const job = await this.getJob(jobId);
        if (!job) return undefined;

        const normalizedUpdates: Partial<JobState> = {
            ...updates
        };

        if (job.artifacts && normalizedUpdates.artifacts && typeof job.artifacts === 'object' && typeof normalizedUpdates.artifacts === 'object') {
            normalizedUpdates.artifacts = {
                ...job.artifacts,
                ...normalizedUpdates.artifacts
            };
        }

        if (!normalizedUpdates.stage && normalizedUpdates.status) {
            normalizedUpdates.stage = normalizedUpdates.status;
        }

        const next: JobState = {
            ...job,
            ...normalizedUpdates,
            updatedAt: new Date().toISOString()
        };

        await redis.set(this.keyJob(jobId), JSON.stringify(next));

        if (this.isTerminal(next.status)) {
            if (next.sourceUrl) {
                await redis.del(this.keyUrlLock(next.tenantId, next.sourceUrl));
            }
            await redis.del(this.keySelectionTimeout(next.jobId));
        }

        if (next.webhook?.url) {
            if (next.status === 'awaiting_selection') {
                await this.emitWebhookEvent(next, 'job.awaiting_selection', {
                    jobId: next.jobId,
                    status: next.status,
                    progress: next.progress,
                    stage: next.stage,
                    topicCandidates: next.topicCandidates
                });
            } else if (next.status === 'completed') {
                await this.emitWebhookEvent(next, 'job.completed', {
                    jobId: next.jobId,
                    status: next.status,
                    progress: next.progress,
                    artifacts: next.artifacts,
                    result: next.result
                });
            } else if (next.status === 'failed') {
                await this.emitWebhookEvent(next, 'job.failed', {
                    jobId: next.jobId,
                    status: next.status,
                    progress: next.progress,
                    error: next.error || next.message
                });
            } else if (next.status !== 'queued') {
                await this.emitWebhookEvent(next, 'job.progress', {
                    jobId: next.jobId,
                    status: next.status,
                    progress: next.progress,
                    stage: next.stage,
                    message: next.message
                });
            }
        }

        return next;
    }

    static async markSelectionTimeoutScheduled(jobId: string): Promise<void> {
        await ensureRedisConnected();
        await redis.set(this.keySelectionTimeout(jobId), '1', 'EX', Math.ceil(ENV.DISCOVERY_SELECTION_TIMEOUT_MS / 1000) + 30);
    }

    static async clearSelectionTimeoutScheduled(jobId: string): Promise<void> {
        await ensureRedisConnected();
        await redis.del(this.keySelectionTimeout(jobId));
    }

    static async isSelectionTimeoutScheduled(jobId: string): Promise<boolean> {
        await ensureRedisConnected();
        const exists = await redis.get(this.keySelectionTimeout(jobId));
        return Boolean(exists);
    }

    static async upsertTopicCandidates(jobId: string, candidates: TopicCandidate[]): Promise<JobState | undefined> {
        return this.updateJob(jobId, { topicCandidates: candidates });
    }

    static async setSelection(jobId: string, selection: string[] | 'all' | 'top1' | 'auto_best'): Promise<JobState | undefined> {
        return this.updateJob(jobId, { selection });
    }

    static async getJobFromIdempotency(tenantId: string, idempotencyKey: string): Promise<JobState | undefined> {
        await ensureRedisConnected();
        const jobId = await redis.get(this.keyIdempotency(tenantId, idempotencyKey));
        if (!jobId) return undefined;
        return this.getJob(jobId);
    }

    static async bindIdempotency(tenantId: string, idempotencyKey: string, jobId: string): Promise<void> {
        await ensureRedisConnected();
        await redis.set(this.keyIdempotency(tenantId, idempotencyKey), jobId, 'EX', 60 * 60 * 24);
    }

    static async getActiveJobByUrl(tenantId: string, sourceUrl: string): Promise<JobState | undefined> {
        await ensureRedisConnected();

        const activeJobId = await redis.get(this.keyUrlLock(tenantId, sourceUrl));
        if (!activeJobId) return undefined;

        const job = await this.getJob(activeJobId);
        if (!job) {
            await redis.del(this.keyUrlLock(tenantId, sourceUrl));
            return undefined;
        }

        if (this.isTerminal(job.status)) {
            await redis.del(this.keyUrlLock(tenantId, sourceUrl));
            return undefined;
        }

        return job;
    }

    static async emitWebhookEvent(
        job: JobState,
        event: 'job.queued' | 'job.started' | 'job.progress' | 'job.awaiting_selection' | 'job.completed' | 'job.failed',
        payload: Record<string, unknown>
    ): Promise<void> {
        if (!job.webhook?.url) return;

        const eventFilter = job.webhook.events;
        if (Array.isArray(eventFilter) && eventFilter.length > 0 && !eventFilter.includes(event)) {
            return;
        }

        await enqueueWebhookEvent({
            event,
            jobId: job.jobId,
            tenantId: job.tenantId,
            webhook: job.webhook,
            payload
        });
    }
}
