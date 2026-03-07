import { Worker } from 'bullmq';
import { ENV } from '../config/env';
import { ensureRedisConnected, queueConnection, wireRedisLogging } from '../queue/connection';
import { RenderJobPayload } from '../queue/queues';
import { JobManager } from '../services/job-manager.service';
import { Orchestrator } from '../services/orchestrator.service';
import { log } from '../utils/logger';

process.on('unhandledRejection', (reason) => {
    log.error({ reason }, '[RENDER-WORKER] Unhandled Promise Rejection');
});

process.on('uncaughtException', (error) => {
    log.error({ err: error }, '[RENDER-WORKER] Uncaught Exception');
});

async function processRenderJob(data: RenderJobPayload): Promise<Record<string, unknown>> {
    const job = await JobManager.getJob(data.jobId);
    if (!job) {
        throw new Error(`Job not found: ${data.jobId}`);
    }

    await JobManager.updateJob(job.jobId, {
        status: 'rendering',
        progress: Math.max(job.progress, 63),
        stage: 'render_worker_pickup',
        message: `Picked up by render worker (${data.triggerReason || 'initial'})`
    });

    const result = await Orchestrator.processPreparedRender(job.jobId);

    return {
        rendered: true,
        output: result
    };
}

async function startRenderWorker(): Promise<void> {
    await ensureRedisConnected();
    wireRedisLogging();

    const worker = new Worker(
        ENV.RENDER_QUEUE_NAME,
        async (job) => {
            const data = job.data as RenderJobPayload;
            log.info({ jobId: data.jobId, queueJobId: job.id, reason: data.triggerReason }, '[RENDER-WORKER] Starting render job');
            return processRenderJob(data);
        },
        {
            connection: queueConnection(),
            prefix: ENV.REDIS_PREFIX,
            concurrency: ENV.RENDER_WORKER_CONCURRENCY,
            lockDuration: 30 * 60 * 1000,
            stalledInterval: 60 * 1000,
            maxStalledCount: 2
        }
    );

    worker.on('completed', (job) => {
        log.info({ jobId: job.data?.jobId, queueJobId: job.id }, '[RENDER-WORKER] Render queue job completed');
    });

    worker.on('failed', async (job, err) => {
        const jobId = job?.data?.jobId as string | undefined;
        log.error({ jobId, queueJobId: job?.id, err: err.message }, '[RENDER-WORKER] Render queue job failed');
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

    log.info(
        {
            renderQueue: ENV.RENDER_QUEUE_NAME,
            renderConcurrency: ENV.RENDER_WORKER_CONCURRENCY
        },
        '[RENDER-WORKER] Started'
    );
}

startRenderWorker().catch((err) => {
    log.error({ err: err.message }, '[RENDER-WORKER] Failed to start');
    process.exit(1);
});
