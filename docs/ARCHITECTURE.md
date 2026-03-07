# Clipper Architecture

Dokumen ini menjelaskan arsitektur aktif yang sekarang digunakan oleh repo.

## Topology

```text
Client
  -> API (`src/index.ts`)
  -> Redis / BullMQ
  -> Worker (`src/workers/clip.worker.ts`)
  -> Orchestrator (`src/services/orchestrator.service.ts`)
  -> R2 / S3-compatible storage
  -> Webhook Worker (`src/workers/webhook.worker.ts`)
```

## API Surface

Endpoint utama:

- `POST /api/v1/jobs`
- `GET /api/v1/jobs/:jobId`
- `GET /api/v1/jobs/:jobId/topics`
- `POST /api/v1/jobs/:jobId/selection`
- `GET /api/v1/jobs/:jobId/output`
- `GET /health`
- `GET /api/health`

Input utama menerima:

- `youtubeUrl`
- `mode`
- `selectionPolicy`
- `customization`
- `webhook`

## Processing Flow

```text
POST /api/v1/jobs
  -> JobManager menyimpan state awal di Redis
  -> BullMQ enqueue clip job
  -> worker mengambil job
  -> mode auto/discovery menentukan perlu topic discovery atau tidak
  -> orchestrator download source video
  -> extract audio, transcribe, analyze, cut, subtitle, portrait render
  -> apply customization (font subtitle, filter video)
  -> upload video final + analysis markdown ke R2
  -> cleanup temp/results lokal
  -> job result tersedia di /api/v1/jobs/:jobId/output
```

## Core Components

### API Layer

- `src/index.ts`
  - validasi request dasar
  - create job dan status polling
  - endpoint output final untuk consumer downstream

### Queue and Job State

- `src/queue/queues.ts`
  - kontrak payload queue
  - definisi customization
- `src/services/job-manager.service.ts`
  - state job di Redis
  - dedupe source URL dan idempotency
  - webhook event emission

### Workers

- `src/workers/clip.worker.ts`
  - discovery mode
  - selection handling
  - enqueue fallback selection
  - invoke orchestrator render
- `src/workers/webhook.worker.ts`
  - dispatch webhook event async

### Media and AI Pipeline

- `src/services/orchestrator.service.ts`
  - koordinasi seluruh pipeline
- `src/services/youtube.service.ts`
  - metadata dan download source video
- `src/services/ffmpeg.service.ts`
  - cut, concat, thumbnail, filter, render helper
- `src/services/whisper.service.ts`
  - transkripsi audio
- `src/services/ai-analyzer.service.ts`
  - topic discovery, director cut, publish metadata
- `src/services/subtitle.service.ts`
  - subtitle ASS dan karaoke
- `src/services/portrait-converter.service.ts`
  - render portrait 9:16
- `src/services/face-detector.service.ts`
  - subject positioning dan fallback heuristic/YOLO
- `src/services/s3.service.ts`
  - upload artifact final ke R2

## Runtime Dependencies

- Node.js
- Redis
- FFmpeg / ffprobe
- yt-dlp
- kredensial AI dan Whisper
- kredensial Cloudflare R2
- Python dependency tambahan bila YOLO diaktifkan

## Deployment Shape

`docker-compose.yml` memisahkan service berikut:

- `redis`
- `api`
- `worker`
- `webhooks`

Ini membuat API tetap responsif saat proses render berjalan lama di worker.

## Output Contract

Job yang selesai menghasilkan payload final berbentuk:

- `videoUrl`
- `analysisUrl`
- `postingTitle`
- `caption`
- `captionWithHashtags`
- `hashtags`
- `duration`

## Known Operational Gaps

- CI belum tersedia
- Validasi Docker belum dijalankan pada host kerja ini
- monitoring production dan metrics belum ditambahkan
