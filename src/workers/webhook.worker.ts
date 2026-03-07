import { createHmac } from 'crypto';
import axios from 'axios';
import { Worker } from 'bullmq';
import { ENV } from '../config/env';
import { ensureRedisConnected, queueConnection, wireRedisLogging } from '../queue/connection';
import { WebhookEventPayload } from '../queue/queues';
import { log } from '../utils/logger';

function signPayload(secret: string | undefined, body: string): string | undefined {
    if (!secret) return undefined;
    return createHmac('sha256', secret).update(body).digest('hex');
}

async function dispatchWebhook(job: WebhookEventPayload): Promise<void> {
    const body = JSON.stringify({
        event: job.event,
        jobId: job.jobId,
        tenantId: job.tenantId,
        timestamp: new Date().toISOString(),
        data: job.payload
    });

    const signature = signPayload(job.webhook.secret, body);

    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Clipper-Event': job.event,
        'X-Clipper-Job-Id': job.jobId
    };

    if (job.webhook.bearerToken) {
        headers.Authorization = `Bearer ${job.webhook.bearerToken}`;
    }

    // Legacy compatibility: keep signature support if secret is still provided.
    if (signature) {
        headers['X-Clipper-Signature'] = signature;
    }

    await axios.post(job.webhook.url, body, {
        headers,
        timeout: 20000
    });
}

async function startWebhookWorker(): Promise<void> {
    await ensureRedisConnected();
    wireRedisLogging();

    const worker = new Worker(
        ENV.WEBHOOK_QUEUE_NAME,
        async (bullJob) => {
            const payload = bullJob.data as WebhookEventPayload;
            await dispatchWebhook(payload);
        },
        {
            connection: queueConnection(),
            prefix: ENV.REDIS_PREFIX,
            concurrency: ENV.WEBHOOK_WORKER_CONCURRENCY
        }
    );

    worker.on('completed', (job) => {
        log.info(
            {
                queueJobId: job.id,
                event: job.data?.event,
                jobId: job.data?.jobId
            },
            '[WEBHOOK-WORKER] Delivered'
        );
    });

    worker.on('failed', (job, err) => {
        log.error(
            {
                queueJobId: job?.id,
                event: job?.data?.event,
                jobId: job?.data?.jobId,
                attemptsMade: job?.attemptsMade,
                err: err.message
            },
            '[WEBHOOK-WORKER] Delivery failed'
        );
    });

    log.info(
        {
            queue: ENV.WEBHOOK_QUEUE_NAME,
            concurrency: ENV.WEBHOOK_WORKER_CONCURRENCY,
            maxRetries: ENV.WEBHOOK_MAX_RETRIES
        },
        '[WEBHOOK-WORKER] Started'
    );
}

startWebhookWorker().catch((err) => {
    log.error({ err: err.message }, '[WEBHOOK-WORKER] Failed to start');
    process.exit(1);
});
