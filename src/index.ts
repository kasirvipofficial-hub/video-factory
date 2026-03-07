import cors from 'cors';
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { ENV } from './config/env';
import { ClipCustomization } from './queue/queues';
import { enqueueClipJob } from './queue/queues';
import { JobManager } from './services/job-manager.service';
import { log } from './utils/logger';

const app = express();
app.use(cors());
app.use(express.json());

process.on('unhandledRejection', (reason) => {
    log.error({ reason }, '[FATAL-GUARD] Unhandled Promise Rejection');
});

process.on('uncaughtException', (error) => {
    log.error({ err: error }, '[FATAL-GUARD] Uncaught Exception');
});

type JobMode = 'auto' | 'discover_only' | 'produce';
type SelectionPolicy = 'top1' | 'wait_user' | 'all' | 'auto_best';

function getTenantId(req: express.Request): string {
    return (req.header('X-Tenant-Id') || ENV.DEFAULT_TENANT_ID).trim();
}

function getIdempotencyKey(req: express.Request): string | undefined {
    const value = req.header('X-Idempotency-Key');
    if (!value) return undefined;
    return value.trim();
}

function parseMode(mode: unknown): JobMode {
    if (mode === 'discover_only' || mode === 'produce' || mode === 'auto') {
        return mode;
    }
    return 'auto';
}

function parseSelectionPolicy(policy: unknown): SelectionPolicy {
    if (policy === 'top1' || policy === 'wait_user' || policy === 'all' || policy === 'auto_best') {
        return policy;
    }
    return 'all';
}

function isValidYouTubeUrl(url: string): boolean {
    return url.includes('youtube.com') || url.includes('youtu.be');
}

function hasValidBearerToken(req: express.Request): boolean {
    if (!ENV.API_BEARER_TOKEN) return true;

    const authHeader = req.header('Authorization') || '';
    if (!authHeader.startsWith('Bearer ')) return false;

    const token = authHeader.slice('Bearer '.length).trim();
    return token.length > 0 && token === ENV.API_BEARER_TOKEN;
}

function enforceBearerAuth(req: express.Request, res: express.Response): express.Response | null {
    if (hasValidBearerToken(req)) return null;

    return res.status(401).json({
        error: 'Unauthorized',
        message: 'Provide Authorization: Bearer <token>'
    });
}

async function createJobFromRequest(
    request: {
        tenantId: string;
        idempotencyKey?: string;
        youtubeUrl?: string;
        mode?: unknown;
        selectionPolicy?: unknown;
        customization?: unknown;
        webhook?: unknown;
    },
    port: number
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
    const tenantId = request.tenantId;
    const idempotencyKey = request.idempotencyKey;

    const youtubeUrl = request.youtubeUrl;
    const mode = parseMode(request.mode);
    const selectionPolicy = parseSelectionPolicy(request.selectionPolicy);
    const customization = (request.customization || {}) as ClipCustomization;
    const webhook = request.webhook as any;

    if (!youtubeUrl) {
        return { statusCode: 400, body: { error: 'Missing youtubeUrl in request body' } };
    }

    if (!isValidYouTubeUrl(youtubeUrl)) {
        return { statusCode: 400, body: { error: 'Invalid YouTube URL' } };
    }

    if (idempotencyKey) {
        const idemJob = await JobManager.getJobFromIdempotency(tenantId, idempotencyKey);
        if (idemJob) {
            return {
                statusCode: 202,
                body: {
                    success: true,
                    deduped: true,
                    reason: 'idempotency_key',
                    jobId: idemJob.jobId,
                    statusUrl: `http://localhost:${port}/api/v1/jobs/${idemJob.jobId}`
                }
            };
        }
    }

    const activeJob = await JobManager.getActiveJobByUrl(tenantId, youtubeUrl);
    if (activeJob) {
        if (idempotencyKey) {
            await JobManager.bindIdempotency(tenantId, idempotencyKey, activeJob.jobId);
        }

        return {
            statusCode: 202,
            body: {
                success: true,
                deduped: true,
                reason: 'active_source_url',
                jobId: activeJob.jobId,
                statusUrl: `http://localhost:${port}/api/v1/jobs/${activeJob.jobId}`
            }
        };
    }

    const jobId = uuidv4();

    const job = await JobManager.createJob({
        jobId,
        tenantId,
        sourceUrl: youtubeUrl,
        mode,
        selectionPolicy,
        customization,
        webhook
    });

    if (idempotencyKey) {
        await JobManager.bindIdempotency(tenantId, idempotencyKey, jobId);
    }

    await enqueueClipJob({
        jobId,
        tenantId,
        youtubeUrl,
        mode,
        selectionPolicy,
        customization,
        webhook,
        triggerReason: 'initial'
    });

    await JobManager.emitWebhookEvent(job, 'job.queued', {
        jobId,
        status: job.status,
        progress: job.progress,
        mode,
        selectionPolicy
    });

    return {
        statusCode: 202,
        body: {
            success: true,
            jobId,
            statusUrl: `http://localhost:${port}/api/v1/jobs/${jobId}`
        }
    };
}

app.post('/api/v1/jobs', async (req, res) => {
    const unauthorized = enforceBearerAuth(req, res);
    if (unauthorized) return unauthorized;

    const result = await createJobFromRequest(
        {
            tenantId: getTenantId(req),
            idempotencyKey: getIdempotencyKey(req),
            youtubeUrl: req.body?.youtubeUrl,
            mode: req.body?.mode,
            selectionPolicy: req.body?.selectionPolicy,
            customization: req.body?.customization,
            webhook: req.body?.webhook
        },
        ENV.PORT
    );

    return res.status(result.statusCode).json(result.body);
});

app.get('/health', (_req, res) => {
    return res.json({
        ok: true,
        service: 'clipper-api',
        port: ENV.PORT,
        time: new Date().toISOString()
    });
});

app.get('/api/health', (_req, res) => {
    return res.json({
        ok: true,
        service: 'clipper-api',
        port: ENV.PORT,
        time: new Date().toISOString()
    });
});

app.get('/api/v1/jobs/:jobId', async (req, res) => {
    const job = await JobManager.getJob(req.params.jobId);
    if (!job) {
        return res.status(404).json({ error: 'Job not found' });
    }

    return res.json({ success: true, job });
});

app.get('/api/v1/jobs/:jobId/output', async (req, res) => {
    const job = await JobManager.getJob(req.params.jobId);
    if (!job) {
        return res.status(404).json({ error: 'Job not found' });
    }

    if (job.status !== 'completed' || !job.result) {
        return res.status(409).json({
            error: 'Job output is not ready',
            status: job.status
        });
    }

    return res.json({
        success: true,
        jobId: job.jobId,
        output: job.result
    });
});

app.get('/api/v1/jobs/:jobId/topics', async (req, res) => {
    const job = await JobManager.getJob(req.params.jobId);
    if (!job) {
        return res.status(404).json({ error: 'Job not found' });
    }

    return res.json({
        success: true,
        jobId: job.jobId,
        status: job.status,
        topicCandidates: job.topicCandidates || []
    });
});

app.post('/api/v1/jobs/:jobId/selection', async (req, res) => {
    const unauthorized = enforceBearerAuth(req, res);
    if (unauthorized) return unauthorized;

    const job = await JobManager.getJob(req.params.jobId);
    if (!job) {
        return res.status(404).json({ error: 'Job not found' });
    }

    if (job.status !== 'awaiting_selection') {
        return res.status(409).json({
            error: 'Job is not awaiting selection',
            status: job.status
        });
    }

    const selection = req.body?.selection as string[] | 'all' | 'top1' | 'auto_best' | undefined;
    if (!selection || (selection !== 'all' && selection !== 'top1' && selection !== 'auto_best' && !Array.isArray(selection))) {
        return res.status(400).json({
            error: 'selection must be one of: "all", "top1", "auto_best", or array of topic IDs'
        });
    }

    const updated = await JobManager.setSelection(job.jobId, selection);
    await JobManager.clearSelectionTimeoutScheduled(job.jobId);

    await enqueueClipJob({
        jobId: job.jobId,
        tenantId: job.tenantId,
        youtubeUrl: job.sourceUrl,
        mode: 'produce',
        selectionPolicy: job.selectionPolicy,
        selection,
            customization: job.customization,
        webhook: job.webhook,
        triggerReason: 'selection'
    });

    return res.status(202).json({
        success: true,
        jobId: job.jobId,
        status: updated?.status || job.status,
        message: 'Selection accepted, rendering queued'
    });
});

app.get('/api', (_req, res) => {
    return res.json({
        service: 'Clipper API v1',
        endpoints: {
            createJob: 'POST /api/v1/jobs',
            jobStatus: 'GET /api/v1/jobs/:jobId',
            topicCandidates: 'GET /api/v1/jobs/:jobId/topics',
            selection: 'POST /api/v1/jobs/:jobId/selection'
        }
    });
});

// Legacy compatibility routes.
app.post('/api/clip', async (req, res) => {
    const unauthorized = enforceBearerAuth(req, res);
    if (unauthorized) return unauthorized;

    const result = await createJobFromRequest(
        {
            tenantId: getTenantId(req),
            idempotencyKey: getIdempotencyKey(req),
            youtubeUrl: req.body?.url,
            mode: 'auto',
            selectionPolicy: 'all',
            customization: req.body?.customization,
            webhook: req.body?.webhookUrl ? { url: req.body.webhookUrl } : undefined
        },
        ENV.PORT
    );

    return res.status(result.statusCode).json(result.body);
});

app.get('/api/clip', async (req, res) => {
    const unauthorized = enforceBearerAuth(req, res);
    if (unauthorized) return unauthorized;

    const result = await createJobFromRequest(
        {
            tenantId: getTenantId(req),
            idempotencyKey: getIdempotencyKey(req),
            youtubeUrl: req.query.url as string | undefined,
            mode: 'auto',
            selectionPolicy: 'all',
            customization: req.query.customization,
            webhook: req.query.webhookUrl ? { url: req.query.webhookUrl as string } : undefined
        },
        ENV.PORT
    );

    return res.status(result.statusCode).json(result.body);
});

app.get('/api/status/:jobId', async (req, res) => {
    const job = await JobManager.getJob(req.params.jobId);
    if (!job) {
        return res.status(404).json({ error: 'Job not found' });
    }
    return res.json({ success: true, job });
});

app.listen(ENV.PORT, () => {
    log.info({
        port: ENV.PORT,
        createJob: `POST http://localhost:${ENV.PORT}/api/v1/jobs`,
        status: `GET http://localhost:${ENV.PORT}/api/v1/jobs/:jobId`
    }, 'Clipper API ready');
});
