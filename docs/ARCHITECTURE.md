# 🎬 Clipper - Architecture Overview

## Current Pipeline Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         REST API Server                          │
│                       (Express.js Port 8080)                     │
└────────────────────┬────────────────────────────────────────────┘
                     │
                     ▼
        ┌────────────────────────────┐
        │   API Endpoints            │
        │ • POST /api/clip           │
        │ • GET /api/status/:jobId   │
        │ • GET /api/health (TODO)   │
        └────────────────────────────┘
                     │
                     ▼
        ┌────────────────────────────────────────────┐
        │      JobManager (In-Memory Queue)          │
        │  • Job creation & tracking                 │
        │  • Status updates                          │
        │  • Progress tracking (0-100%)              │
        └────────────────────────────────────────────┘
                     │
                     ▼
        ┌────────────────────────────────────────────┐
        │    Orchestrator Service (Main Pipeline)    │
        └────────────────────────────────────────────┘
                     │
        ┌────────────┼────────────┬────────────┬─────────┐
        │            │            │            │         │
        ▼            ▼            ▼            ▼         ▼
    [1]         [2]          [3]         [4]        [5]
  YouTube    FFmpeg        Whisper      AI         Subtitle
  Service    Service       Service      Analyzer   Service
    │            │            │            │         │
    │            │           ❌️           ❌️        │
    ▼            ▼    (401 Error)  (401 Error)   ▼
  video.mp4  audio.mp3                    highlights  subtitles.ass
    │                                       │         │
    │                                       ▼         │
    │                                    FFmpeg      │
    │                                    (Cut)       │
    │                                       │         │
    ▼                                       ▼         ▼
  ┌────────────────────────────────────────────────────────┐
  │              [6] FFmpeg Concat Service                  │
  │         • Join highlight segments                      │
  │         • Apply color grading                          │
  └────────────────────────────────────────────────────────┘
                     │
        ┌────────────┴────────────┐
        │                         │
        ▼                         ▼
    [7] TTS Service          [8] Rendering
   (Generate Voice)        (libx264 + AAC)
   ❌️ (Broken)              ✅ (Working)
        │                         │
        └────────────┬────────────┘
                     │
                     ▼
        ┌────────────────────────────────┐
        │   [9] Thumbnail Generation     │
        │        (1-second JPEG)         │
        │        ✅ (Working)            │
        └────────────────────────────────┘
                     │
                     ▼
        ┌────────────────────────────────┐
        │    [10] Output Management      │
        │  • Save video (21.6MB)         │
        │  • Save thumbnail (89KB)       │
        │  • Save subtitles              │
        │  • Upload to S3/R2 (TODO)      │
        └────────────────────────────────┘
                     │
                     ▼
        ┌────────────────────────────────┐
        │      Output Directory          │
        │  • {jobId}.mp4                 │
        │  • {jobId}_thumb.jpg           │
        │  • temp/{jobId}/ (cleanup)     │
        └────────────────────────────────┘
```

## Service Dependencies & Status

```
┌─────────────────────────────────────────────────────────┐
│                  EXTERNAL SERVICES                       │
├─────────────────────────────────────────────────────────┤
│ YT-DLP (YouTube)      ✅ Working                         │
│ FFmpeg (Video)        ✅ Working                         │
│ Whisper API           ❌ 401 Unauthorized                │
│ AI LLM (Sumopod)      ❌ 401 Unauthorized                │
│ TTS Provider          ❌ Not Implemented (gTTS broken)  │
│ S3/R2 (Storage)       ⚠️  Optional (not used yet)       │
└─────────────────────────────────────────────────────────┘
```

## Development Phases Timeline

```
WEEK 1 (CRITICAL FIX)
├─ Day 1-2: Fix API credentials + TTS service
├─ Day 3: Add error handling + job persistence
├─ Day 4: Output management + file uploads
└─ Day 5: Testing + Documentation

WEEK 2-3 (INFRASTRUCTURE)
├─ Database integration (MongoDB/PostgreSQL)
├─ Queue system (Bull/RabbitMQ)
├─ Docker + deployment setup
└─ CI/CD pipeline (GitHub Actions)

WEEK 4+ (FEATURES)
├─ Batch processing
├─ Advanced highlight detection
├─ Frontend dashboard
└─ CLI enhancements
```

## File Structure (Sources)

```
src/
├── index.ts                      # Express server + API endpoints
├── config/
│   └── env.ts                    # Environment configuration
├── services/
│   ├── orchestrator.service.ts   # 🧠 Main pipeline controller
│   ├── youtube.service.ts        # ✅ Download videos
│   ├── ffmpeg.service.ts         # ✅ Video processing
│   ├── whisper.service.ts        # ❌ Transcription (401 error)
│   ├── ai-analyzer.service.ts    # ❌ Highlight detection (401)
│   ├── tts.service.ts            # ❌ Voice generation (broken)
│   ├── subtitle.service.ts       # ⚠️  Disabled (FFmpeg issues)
│   ├── s3.service.ts             # ⚠️  Storage (not fully used)
│   ├── job-manager.service.ts    # ✅ Job tracking
│   └── database.service.ts       # 🔜 TODO: persistence layer
└── utils/
    └── logger.ts                 # ✅ Pino logging
```

## API Request Flow

```
POST /api/clip with JSON body
{
  "url": "https://www.youtube.com/watch?v=...",
  "webhookUrl": "https://example.com/webhook" (optional)
}
                    │
                    ▼
        Returns 202 Accepted + jobId
        {
          "jobId": "uuid-v4",
          "statusUrl": "http://localhost:8080/api/status/{jobId}"
        }
                    │
                    ▼
        Background Processing Starts
                    │
         ┌──────────┼──────────┐
         ▼          ▼          ▼
    GET /api/status/{jobId}
    Returns current job state:
    {
      "jobId": "uuid",
      "status": "rendering",      (downloading|extracting|analyzing|rendering|completed|failed)
      "progress": 75,             (0-100)
      "message": "Working...",
      "result": {                 (if completed)
        "videoPath": "output/...",
        "thumbnailPath": "output/...",
        "metadata": {...}
      }
    }
```

## Current Test Results (Latest)

| Metric | Result |
|--------|--------|
| YouTube Download | ✅ 22.1 MB in 7-8s |
| Audio Extraction | ✅ MP3 in 3-4s |
| Transcription | ❌ 401 Error |
| AI Analysis | ❌ 401 Error |
| Video Rendering | ✅ 21.6 MB in 30s |
| Thumbnail | ✅ 89 KB in <1s |
| **Total Time** | ~52s (with fallbacks) |
| **Success Rate** | 100% (graceful degradation) |

---

Last Updated: March 6, 2026
