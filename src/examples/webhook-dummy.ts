import express from 'express';

const app = express();
app.use(express.json({ limit: '2mb' }));

const port = parseInt(process.env.DUMMY_WEBHOOK_PORT || '9999', 10);
const expectedToken = (process.env.DUMMY_WEBHOOK_BEARER || '').trim();
const events: Array<{
    at: string;
    path: string;
    event?: string;
    jobId?: string;
    authPresent: boolean;
    body: unknown;
}> = [];

function isAuthorized(header: string | undefined): boolean {
    if (!expectedToken) return true;
    if (!header) return false;
    const prefix = 'Bearer ';
    if (!header.startsWith(prefix)) return false;
    return header.slice(prefix.length).trim() === expectedToken;
}

app.post('/webhook-test', (req, res) => {
    const auth = req.header('Authorization');

    if (!isAuthorized(auth)) {
        return res.status(401).json({
            ok: false,
            error: 'Unauthorized',
            message: 'Provide Authorization: Bearer <token>'
        });
    }

    const item = {
        at: new Date().toISOString(),
        path: req.path,
        event: req.header('X-Clipper-Event') || undefined,
        jobId: req.header('X-Clipper-Job-Id') || undefined,
        authPresent: Boolean(auth),
        body: req.body
    };

    events.push(item);
    if (events.length > 100) {
        events.shift();
    }

    console.log('[DUMMY-WEBHOOK] event received', {
        event: item.event,
        jobId: item.jobId,
        at: item.at,
        authPresent: item.authPresent
    });

    return res.status(200).json({ ok: true, received: item.event || 'unknown' });
});

app.get('/events', (_req, res) => {
    return res.json({
        ok: true,
        count: events.length,
        events
    });
});

app.get('/health', (_req, res) => {
    return res.json({
        ok: true,
        service: 'dummy-webhook',
        port,
        bearerRequired: Boolean(expectedToken)
    });
});

app.listen(port, () => {
    console.log(`[DUMMY-WEBHOOK] listening on http://127.0.0.1:${port}`);
    console.log('[DUMMY-WEBHOOK] POST /webhook-test, GET /events, GET /health');
});
