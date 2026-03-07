import { createHash } from 'crypto';
import { ENV } from '../config/env';
import { ensureRedisConnected, redis } from '../queue/connection';
import { ClipCustomization, ClipJobPayload, clipQueue, enqueueClipJob, enqueueWebhookEvent, JobWebhookConfig, renderQueue, RenderJobPayload } from '../queue/queues';
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
    | 'generating_metadata'
    | 'uploading_artifacts'
    | 'finalizing'
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

    private static isStale(job: JobState): boolean {
        const updatedAt = new Date(job.updatedAt).getTime();
        if (!Number.isFinite(updatedAt)) {
            return false;
        }

        return Date.now() - updatedAt >= ENV.JOB_STALE_AFTER_MS;
    }

    private static async hasQueuedWork(jobId: string): Promise<boolean> {
        const clipJobs = await clipQueue.getJobs(['active', 'waiting', 'delayed', 'prioritized', 'paused', 'waiting-children']);
        const renderJobs = await renderQueue.getJobs(['active', 'waiting', 'delayed', 'prioritized', 'paused', 'waiting-children']);
        const jobs = [...clipJobs, ...renderJobs];
        const now = Date.now();

        return jobs.some((queueJob) => {
            const payload = queueJob.data as ClipJobPayload | RenderJobPayload | undefined;
            if (payload?.jobId !== jobId) {
                return false;
            }

            if (queueJob.processedOn && now - queueJob.processedOn >= ENV.JOB_STALE_AFTER_MS) {
                log.warn(
                    { jobId, queueJobId: queueJob.id, processedOn: queueJob.processedOn },
                    '[RECOVERY] Ignoring stale active BullMQ entry during recovery check'
                );
                return false;
            }

            return true;
        });
    }

    private static buildRecoveryPayload(job: JobState): ClipJobPayload | undefined {
        if (!job.sourceUrl) {
            return undefined;
        }

        if (job.status === 'awaiting_selection' && job.selectionPolicy === 'wait_user') {
            return undefined;
        }

        const lateStageStatuses: JobStatus[] = [
            'cutting',
            'analyzing_faces',
            'converting_format',
            'rendering',
            'generating_metadata',
            'uploading_artifacts',
            'finalizing'
        ];

        if (lateStageStatuses.includes(job.status) && job.topicCandidates.length > 0) {
            const fallbackSelection = job.selection
                ?? (job.selectionPolicy === 'auto_best'
                    ? 'auto_best'
                    : job.selectionPolicy === 'top1'
                        ? 'top1'
                        : job.selectionPolicy === 'all'
                            ? 'all'
                            : undefined);

            if (!fallbackSelection && job.selectionPolicy === 'wait_user') {
                return undefined;
            }

            return {
                jobId: job.jobId,
                tenantId: job.tenantId,
                youtubeUrl: job.sourceUrl,
                mode: 'produce',
                selectionPolicy: job.selectionPolicy,
                selection: fallbackSelection,
                customization: job.customization,
                webhook: job.webhook,
                triggerReason: 'recovery'
            };
        }

        return {
            jobId: job.jobId,
            tenantId: job.tenantId,
            youtubeUrl: job.sourceUrl,
            mode: job.mode,
            selectionPolicy: job.selectionPolicy,
            selection: job.selection,
            customization: job.customization,
            webhook: job.webhook,
            triggerReason: 'recovery'
        };
    }

    static async recoverInterruptedJob(job: JobState): Promise<JobState> {
        if (this.isTerminal(job.status) || !this.isStale(job)) {
            return job;
        }

        if (await this.hasQueuedWork(job.jobId)) {
            return job;
        }

        const payload = this.buildRecoveryPayload(job);
        if (!payload) {
            return job;
        }

        log.warn({ jobId: job.jobId, status: job.status, updatedAt: job.updatedAt }, '[RECOVERY] Recovering interrupted job');

        const recovered = await this.updateJob(job.jobId, {
            status: 'queued',
            progress: Math.min(job.progress, 5),
            stage: 'queued',
            message: 'Recovered after worker interruption; requeued for processing.'
        });

        await enqueueClipJob(payload);
        return recovered || job;
    }

    static async recoverInterruptedJobs(): Promise<number> {
        await ensureRedisConnected();
        const keys = await redis.keys(this.keyJob('*'));
        let recoveredCount = 0;

        for (const key of keys) {
            const raw = await redis.get(key);
            if (!raw || !raw.trim().startsWith('{')) {
                continue;
            }

            let job: JobState;
            try {
                const parsed = JSON.parse(raw);
                if (!parsed || typeof parsed !== 'object' || !('jobId' in parsed) || !('status' in parsed)) {
                    continue;
                }
                job = this.normalizeJob(parsed);
            } catch {
                continue;
            }

            const before = job.updatedAt;
            const recovered = await this.recoverInterruptedJob(job);
            if (recovered.updatedAt !== before && recovered.status === 'queued') {
                recoveredCount += 1;
            }
        }

        return recoveredCount;
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

    private static async getJobRaw(jobId: string): Promise<JobState | undefined> {
        await ensureRedisConnected();
        const raw = await redis.get(this.keyJob(jobId));
        if (!raw) return undefined;
        return this.normalizeJob(JSON.parse(raw));
    }

    static async getJob(jobId: string): Promise<JobState | undefined> {
        const job = await this.getJobRaw(jobId);
        if (!job) return undefined;
        return this.recoverInterruptedJob(job);
    }

    static async updateJob(jobId: string, updates: Partial<JobState>): Promise<JobState | undefined> {
        await ensureRedisConnected();
        const job = await this.getJobRaw(jobId);
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
