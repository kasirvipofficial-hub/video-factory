import { Worker } from 'bullmq';
import { ENV } from '../config/env';
import { ensureRedisConnected, queueConnection, wireRedisLogging } from '../queue/connection';
import { ClipJobPayload, enqueueClipJob, enqueueSelectionTimeout, SelectionTimeoutPayload } from '../queue/queues';
import { JobManager, TopicCandidate } from '../services/job-manager.service';
import { Orchestrator } from '../services/orchestrator.service';
import { YouTubeService } from '../services/youtube.service';
import { log } from '../utils/logger';

function resolveSelection(
    candidates: TopicCandidate[],
    selection: string[] | 'all' | 'top1' | 'auto_best' | undefined,
    selectionPolicy: 'top1' | 'wait_user' | 'all' | 'auto_best'
): TopicCandidate[] {
    if (selection === 'all' || (!selection && selectionPolicy === 'all')) {
        return candidates;
    }

    if (selection === 'top1' || (!selection && selectionPolicy === 'top1')) {
        return candidates.length > 0 ? [candidates[0]] : [];
    }

    if (selection === 'auto_best' || (!selection && selectionPolicy === 'auto_best')) {
        return resolveAutoBestSelection(candidates);
    }

    if (Array.isArray(selection) && selection.length > 0) {
        const ids = new Set(selection);
        return candidates.filter((candidate) => ids.has(candidate.topicId));
    }

    return [];
}

function resolveAutoBestSelection(candidates: TopicCandidate[]): TopicCandidate[] {
    if (candidates.length === 0) {
        return [];
    }

    if (candidates.length === 1) {
        return [candidates[0]];
    }

    const sorted = [...candidates].sort((left, right) => right.scoreViral - left.scoreViral || right.confidence - left.confidence);
    const first = sorted[0];
    const second = sorted[1];
    const scoreGap = first.scoreViral - second.scoreViral;
    const secondStrongEnough = second.scoreViral >= 88 && second.confidence >= 0.78;
    const pairCloseEnough = scoreGap <= 6 || (first.scoreViral >= 95 && second.scoreViral >= 90);

    if (secondStrongEnough && pairCloseEnough) {
        return [first, second];
    }

    return [first];
}

async function processClipJob(data: ClipJobPayload): Promise<Record<string, unknown>> {
    const job = await JobManager.getJob(data.jobId);
    if (!job) {
        throw new Error(`Job not found: ${data.jobId}`);
    }

    await JobManager.updateJob(job.jobId, {
        status: 'pending',
        progress: 2,
        stage: 'worker_pickup',
        message: `Picked up by worker (${data.triggerReason || 'initial'})`,
        attempt: (job.attempt || 0) + 1
    });

    await JobManager.emitWebhookEvent(job, 'job.started', {
        jobId: job.jobId,
        status: 'pending',
        stage: 'worker_pickup',
        progress: 2,
        triggerReason: data.triggerReason || 'initial'
    });

    const needsDiscoveryDecision = data.mode === 'discover_only' || data.mode === 'auto';
    const videoInfo = needsDiscoveryDecision ? await YouTubeService.getVideoInfo(data.youtubeUrl) : undefined;
    const isLongVideo = (videoInfo?.duration || 0) >= ENV.DISCOVERY_MIN_VIDEO_SECONDS;

    const shouldRunDiscovery =
        data.mode === 'discover_only'
        || (data.mode === 'auto' && isLongVideo && (!job.topicCandidates || job.topicCandidates.length === 0));

    if (shouldRunDiscovery) {
        await JobManager.updateJob(job.jobId, {
            status: 'analyzing',
            progress: 10,
            stage: 'topic_discovery',
            message: 'Running topic discovery'
        });

        const discovery = await Orchestrator.discoverTopics(data.youtubeUrl, data.jobId);
        const candidates = discovery.candidates;

        const autoBestSelection = job.selectionPolicy === 'auto_best' ? 'auto_best' : job.selection;

        await JobManager.updateJob(job.jobId, {
            status: 'awaiting_selection',
            progress: 62,
            stage: 'awaiting_selection',
            message: job.selectionPolicy === 'auto_best'
                ? 'Topic candidates ready. Auto-selecting best topic(s) for render.'
                : 'Topic candidates ready. Awaiting selection.',
            topicCandidates: candidates,
            artifacts: {
                topicDiscoveryJsonPath: discovery.topicDiscoveryJsonPath,
                topicDiscoveryMarkdownPath: discovery.topicDiscoveryMarkdownPath
            },
            selection: autoBestSelection
        });

        if (data.mode === 'discover_only' && job.selectionPolicy !== 'auto_best') {
            return {
                mode: 'discover_only',
                status: 'awaiting_selection',
                topicCandidates: candidates
            };
        }

        if (job.selectionPolicy === 'auto_best') {
            await JobManager.clearSelectionTimeoutScheduled(job.jobId);
            await enqueueClipJob({
                jobId: job.jobId,
                tenantId: job.tenantId,
                youtubeUrl: job.sourceUrl,
                mode: 'produce',
                selectionPolicy: job.selectionPolicy,
                selection: 'auto_best',
                customization: job.customization,
                webhook: job.webhook,
                triggerReason: 'selection'
            });

            return {
                mode: data.mode,
                status: 'auto_selected',
                topicCandidates: candidates,
                selection: 'auto_best'
            };
        }

        await JobManager.markSelectionTimeoutScheduled(job.jobId);
        await enqueueSelectionTimeout(
            { jobId: job.jobId, tenantId: job.tenantId },
            ENV.DISCOVERY_SELECTION_TIMEOUT_MS
        );

        return {
            mode: data.mode,
            status: 'awaiting_selection',
            topicCandidates: candidates,
            selectionTimeoutMs: ENV.DISCOVERY_SELECTION_TIMEOUT_MS
        };
    }

    const refreshedJob = await JobManager.getJob(job.jobId);
    const candidates = refreshedJob?.topicCandidates || [];
    const effectiveSelection = data.selection ?? refreshedJob?.selection;
    const selectedCandidates = resolveSelection(candidates, effectiveSelection, job.selectionPolicy);

    await JobManager.updateJob(job.jobId, {
        status: 'rendering',
        progress: 70,
        stage: 'rendering',
        message: 'Rendering selected clips',
        selection: effectiveSelection
    });

    const result = await Orchestrator.processYouTubeToClip(
        data.youtubeUrl,
        data.jobId,
        data.webhook?.url,
        {
            selectedCandidates,
            customization: data.customization ?? job.customization,
            minOutputDuration: ENV.MIN_OUTPUT_DURATION,
            maxOutputDuration: ENV.MAX_OUTPUT_DURATION
        }
    );

    await JobManager.clearSelectionTimeoutScheduled(job.jobId);

    return {
        mode: data.mode,
        selectedTopicCount: selectedCandidates.length,
        output: result
    };
}

async function processSelectionTimeout(payload: SelectionTimeoutPayload): Promise<Record<string, unknown>> {
    const job = await JobManager.getJob(payload.jobId);
    if (!job) {
        return { skipped: true, reason: 'job_not_found' };
    }

    if (job.status !== 'awaiting_selection') {
        return { skipped: true, reason: `status_${job.status}` };
    }

    const fallbackSelection: 'top1' | 'all' | 'auto_best' = job.selectionPolicy === 'top1'
        ? 'top1'
        : job.selectionPolicy === 'auto_best'
            ? 'auto_best'
            : 'all';
    await JobManager.setSelection(job.jobId, fallbackSelection);
    await JobManager.clearSelectionTimeoutScheduled(job.jobId);

    await enqueueClipJob({
        jobId: job.jobId,
        tenantId: job.tenantId,
        youtubeUrl: job.sourceUrl,
        mode: 'produce',
        selectionPolicy: job.selectionPolicy,
        selection: fallbackSelection,
        customization: job.customization,
        webhook: job.webhook,
        triggerReason: 'timeout_fallback'
    });

    log.info({ jobId: job.jobId, selection: fallbackSelection }, '[WORKER] Selection timeout fallback queued');

    return {
        fallbackApplied: true,
        selection: fallbackSelection
    };
}

async function startWorker(): Promise<void> {
    await ensureRedisConnected();
    wireRedisLogging();

    const clipWorker = new Worker(
        ENV.CLIP_QUEUE_NAME,
        async (job) => {
            const data = job.data as ClipJobPayload;
            log.info({ jobId: data.jobId, queueJobId: job.id, reason: data.triggerReason }, '[WORKER] Starting clip job');
            return processClipJob(data);
        },
        {
            connection: queueConnection(),
            prefix: ENV.REDIS_PREFIX,
            concurrency: ENV.CLIP_WORKER_CONCURRENCY,
            lockDuration: 30 * 60 * 1000,
            stalledInterval: 60 * 1000,
            maxStalledCount: 2
        }
    );

    const fallbackWorker = new Worker(
        ENV.FALLBACK_QUEUE_NAME,
        async (job) => {
            const data = job.data as SelectionTimeoutPayload;
            log.info({ jobId: data.jobId, queueJobId: job.id }, '[WORKER] Processing selection timeout fallback');
            return processSelectionTimeout(data);
        },
        {
            connection: queueConnection(),
            prefix: ENV.REDIS_PREFIX,
            concurrency: 1
        }
    );

    clipWorker.on('completed', (job) => {
        log.info({ jobId: job.data?.jobId, queueJobId: job.id }, '[WORKER] Clip queue job completed');
    });

    clipWorker.on('failed', async (job, err) => {
        const jobId = job?.data?.jobId as string | undefined;
        log.error({ jobId, queueJobId: job?.id, err: err.message }, '[WORKER] Clip queue job failed');
        if (jobId) {
            await JobManager.updateJob(jobId, {
                status: 'failed',
                progress: 100,
                stage: 'failed',
                message: err.message,
                error: err.stack
            });
        }
    });

    fallbackWorker.on('failed', (job, err) => {
        log.error({ queueJobId: job?.id, err: err.message }, '[WORKER] Fallback queue job failed');
    });

    log.info(
        {
            clipQueue: ENV.CLIP_QUEUE_NAME,
            fallbackQueue: ENV.FALLBACK_QUEUE_NAME,
            clipConcurrency: ENV.CLIP_WORKER_CONCURRENCY
        },
        '[WORKER] Clip worker started'
    );
}

startWorker().catch((err) => {
    log.error({ err: err.message }, '[WORKER] Failed to start');
    process.exit(1);
});
