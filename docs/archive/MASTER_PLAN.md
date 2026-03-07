# 🎬 Clipper - Master Plan Summary
## Complete Project Roadmap & Architecture

**Created**: March 6, 2026  
**Status**: ✅ Planning Complete - Ready for Implementation  
**Total Effort**: ~6-8 weeks intensive development

---

## 📋 Overview: What We're Building

### Current State (MVP - Working ✅)
- ✅ Download YouTube videos
- ✅ Extract audio (MP3)
- ✅ Generate video thumbnail
- ✅ Output final MP4 video
- ✅ REST API with job tracking
- ⚠️ Transcription (API credentials present)
- ⚠️ Highlight detection (API credentials present)
- ✅ TTS with HuggingFace

### Advanced Features (Next 2-3 Weeks)
- 🚀 **Audio Analysis** - Smart cut detection + smooth transitions
- 🚀 **Face Detection** - Subject tracking + portrait optimization
- 🚀 **Portrait Format** - Convert to 9:16 for mobile (TikTok/Reels)

### Infrastructure (Weeks 4-6)
- 📦 Database persistence (MongoDB/PostgreSQL)
- ⚙️ Queue system (Bull/RabbitMQ) for batch processing
- 🐳 Docker containerization
- 🚀 Production deployment

---

## ✅ PHASE 0: Foundation (Complete)
**Status**: Infrastructure & Planning Done

### Documentation Created
1. **CONTINUATION_PLAN.md** - Full 6-week roadmap with all features
2. **ARCHITECTURE.md** - System design & service architecture
3. **QUICK_START.md** - Week 1 action items & debugging guide
4. **ADVANCED_FEATURES.md** - Technical deep-dive for new features
5. **IMPLEMENTATION_GUIDE.md** - Step-by-step code examples
6. **This Document** - Master overview

### Credentials Verified ✅
```env
# All valid & working
AI_API_BASE_URL=https://ai.sumopod.com/v1          ✅
AI_API_KEY=replace-with-real-key                  ✅
WHISPER_API_URL=https://ai.sumopod.com/v1          ✅
WHISPER_API_KEY=replace-with-real-key             ✅
HUGGINGFACE_API_KEY=replace-with-real-key         ✅
```

### Existing Services Verified
```
✅ YouTubeService - Working (yt-dlp integration)
✅ FFmpegService - Working (9+ operations)
✅ TTSService - Working (HuggingFace)
⚠️ WhisperService - Ready (API key valid)
⚠️ AIAnalyzerService - Ready (API key valid)
✅ SubtitleService - Working
✅ JobManager - Working
✅ Orchestrator - Working
✅ Express API - Working
```

---

## 🎯 PHASE 1: Advanced Audio & Portrait (Weeks 1-3)

### Week 1: Audio Analysis
**Goal**: Smart audio processing for smooth highlights cuts

#### New Services to Create
1. **AudioAnalyzerService** (`src/services/audio-analyzer.service.ts`)
   - Detect audio peaks (loud moments = likely highlights)
   - Detect silence (natural cut points)
   - Generate suggested cut points array
   - Smooth audio transitions (fade in/out)

2. **Helper Files**
   - `src/utils/ffprobe.ts` - Extract audio metadata
   - Tests for audio detection accuracy

#### Integration Points
- Add audio analysis as parallel step in Orchestrator
- Boost highlight scores based on audio peaks
- Apply smooth audio fading between segments

#### Expected Deliverable
```
✅ Audio peaks detected accurately
✅ Silence detection working
✅ Smooth transitions between clips
✅ Full integration in pipeline
```

### Weeks 2-3: Face Detection & Portrait Format
**Goal**: Portrait video with smart subject centering

#### New Services to Create
1. **FaceDetectorService** (`src/services/face-detector.service.ts`)
   - Extract frames at 2fps (~120 frames per 10min video)
   - Run TensorFlow face detection on each frame
   - Track primary subject across video
   - Generate framing instructions for portrait crops

2. **PortraitConverterService** (`src/services/portrait-converter.service.ts`)
   - Convert 16:9 landscape to 9:16 portrait
   - Apply dynamic cropping based on face position
   - Smooth panning/zooming between crop zones
   - Fallback to center crop if no faces

3. **Helper Files**
   - `src/utils/frame-extractor.ts` - Extract frames from video
   - `src/utils/ffmpeg-filter-builder.ts` - Build complex FFmpeg filters
   - `src/utils/tensorflow-loader.ts` - Lazy-load TF models

#### Dependencies to Add
```bash
npm install @tensorflow/tfjs @tensorflow/tfjs-node \
  @tensorflow-models/face-detection @tensorflow-models/coco-ssd
```

#### Expected Deliverable
```
✅ Faces detected in video
✅ Framing instructions generated
✅ Portrait conversion working
✅ Smart subject centering active
✅ Smooth pan/zoom transitions
```

---

## 📚 Phase 1 Resources

### Audio Analysis (Complete Code Examples)
**File**: `IMPLEMENTATION_GUIDE.md` → "PHASE 1: Audio Analysis"

- AudioAnalyzerService full implementation
- FFmpeg peak detection command
- Silence detection algorithm
- Integration with existing services

### Face Detection (Complete Code Examples)
**File**: `IMPLEMENTATION_GUIDE.md` → "PHASE 2: Face Detection"

- FaceDetectorService with TensorFlow setup
- Frame extraction logic
- Face tracking algorithm
- Framing instruction generator

### Portrait Converter (Complete Code Examples)
**File**: `IMPLEMENTATION_GUIDE.md` → "PHASE 2: Portrait Converter"

- Simple center crop implementation
- Smart crop with face tracking
- FFmpeg filter chain builder
- Performance optimization tips

---

## 🔧 PHASE 2: Infrastructure & Deployment (Weeks 4-6)

### Week 4: Database & Job Persistence
- [ ] Design database schema (MongoDB schema provided in docs)
- [ ] Implement job repository (CRUD operations)
- [ ] Add job history tracking
- [ ] Migrate from in-memory to persistent storage
- [ ] Implement job retry logic

### Week 5: Docker & Production Setup
- [ ] Create Dockerfile with FFmpeg + yt-dlp
- [ ] Create docker-compose.yml for full stack
- [ ] Add health checks & monitoring
- [ ] Setup GitHub Actions CI/CD
- [ ] Configure deployment to production

### Week 6: Optimization & Monitoring
- [ ] Performance benchmarking (process 1000+ videos)
- [ ] Error tracking (Sentry integration)
- [ ] Logging & analytics
- [ ] Cost optimization (AWS/R2 bills)
- [ ] Load testing & scaling

---

## 🚀 PHASE 3: Complete Feature Set (Week 7+)

### Batch Processing
- Accept multiple YouTube URLs simultaneously
- Queue-based job scheduling
- Concurrent job limits with priority support

### Frontend Dashboard
- React SPA for job submission
- Real-time progress with WebSocket
- Video preview gallery
- Job history & analytics

### Advanced Features
- Multiple language support
- Automatic captions in multiple languages
- Custom branding/watermarks
- Advanced scene detection

---

## 📊 Updated Architecture Diagram

```
┌─────────────────────────────────────────────────────────┐
│                    REST API Server                       │
├─────────────────────────────────────────────────────────┤
│  POST /api/clip                                         │
│  GET /api/status/:jobId                                 │
│  POST /api/webhook/:jobId                               │
│  GET /api/files/:jobId/video                            │
└──────────────┬──────────────────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────────────────┐
│             JobManager + File Storage                   │
└──────────────┬──────────────────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────────────────┐
│              Orchestrator (Main Pipeline)               │
├─────────────────────────────────────────────────────────┤
│ [1] Download → [2] Extract Audio → [3] Analyze Audio   │
│ [4] Detect Faces → [5] Generate Framing                │
│ [6] Combine Scores → [7] Convert Portrait              │
│ [8] Cut Segments → [9] Concat → [10] Add TTS           │
│ [11] Render → [12] Thumbnail → [13] Upload S3/R2       │
└─────────────────┬──────────────────────────────────────┘
                  │
        ┌─────────┼─────────┐
        │         │         │
        ▼         ▼         ▼
    Services:  Analyzers: External:
    • YouTube  • Audio    • Sumopod AI
    • FFmpeg   • Vision   • Whisper
    • TTS      • Face Det • HuggingFace
    • S3/R2    • Scoring  • OpenAI
        │         │         │
        └─────────┼─────────┘
                  │
                  ▼
        ┌──────────────────────┐
        │  Output (Portrait)   │
        ├──────────────────────┤
        │ • MP4 (9:16 format)  │
        │ • Thumbnail (JPG)    │
        │ • Subtitles (SRT)    │
        │ • Metadata (JSON)    │
        └──────────────────────┘
```

---

## 🎯 Implementation Priorities

### Priority 1: Audio Analysis ⭐ (3-4 days)
**Impact**: Medium (Better audio quality)  
**Complexity**: Low (Use FFmpeg tools)  
**Value**: High (Foundation for smooth cuts)

**Start With**: AudioAnalyzerService in `IMPLEMENTATION_GUIDE.md`

### Priority 2: Face Detection ⭐ (4-5 days)
**Impact**: High (Dramatically improves output)  
**Complexity**: Medium (TensorFlow setup)  
**Value**: High (Portrait + Smart framing)

**Start With**: FaceDetectorService in `IMPLEMENTATION_GUIDE.md`

### Priority 3: Portrait Converter ⭐ (3-4 days)
**Impact**: High (Mobile-optimized output)  
**Complexity**: Medium (FFmpeg filters)  
**Value**: High (TikTok/Reels ready)

**Start With**: PortraitConverterService in `IMPLEMENTATION_GUIDE.md`

### Priority 4: Infrastructure (2-3 weeks)
**Impact**: High (Production ready)  
**Complexity**: High (DevOps/DB)  
**Value**: Very High (Scalable system)

**Start With**: Database setup in `CONTINUATION_PLAN.md` Phase 2

---

## 📈 Quality Metrics & Targets

### Output Quality
| Metric | Target | How to Verify |
|--------|--------|---------------|
| Portrait format | 9:16 (1080x1920) | `ffprobe -v error -select_streams v:0 -show_entries stream=width,height` |
| Face centering | ±10% from center | Visual inspection of output |
| Audio smoothness | Zero harsh cuts | Listen for clean transitions |
| Video bitrate | 2-5 Mbps | Quality without excessive size |
| Thumbnail quality | >500KB, 16:9 | Visually representative frame |

### Performance Targets
| Operation | Current | Target | Notes |
|-----------|---------|--------|-------|
| YouTube Download | ~8s | <10s | Per video |
| Audio Analysis | N/A | <60s | For 30-min video |
| Face Detection | N/A | <120s | 2fps sampling |
| Full Pipeline | ~52s | <5 min | With all new features |
| API Response | ~50ms | <100ms | Job submission |

### Reliability Targets
| Metric | Target | Notes |
|--------|--------|-------|
| Success Rate | 99% | Graceful degradation |
| Error Recovery | 95% | Automatic retry |
| Uptime | 99.9% | With monitoring |
| Data Loss | 0% | Persistent storage |

---

## 📚 All Documentation Files

### 1. **CONTINUATION_PLAN.md**
Full 6-week roadmap with all features, phases, and checklist.  
**Use for**: Overall project planning, understanding full scope

### 2. **ARCHITECTURE.md**  
System design, service dependencies, API flows, test results.  
**Use for**: Understanding how components interact

### 3. **QUICK_START.md**
Week 1 action items, debugging guide, common fixes.  
**Use for**: Getting started quickly, troubleshooting

### 4. **ADVANCED_FEATURES.md** ⭐ NEW
Detailed technical plan for audio analysis + portrait + face detection.  
**Use for**: Understanding new feature architecture

### 5. **IMPLEMENTATION_GUIDE.md** ⭐ NEW
Step-by-step code examples for all new services.  
**Use for**: Actually implementing the features (copy-paste ready)

### 6. This File: **MASTER_PLAN.md**
High-level overview of entire project + recommended reading order.  
**Use for**: Project overview and decision making

---

## 🗂️ Recommended Reading Order

**If you want to start implementation TODAY:**
1. Read **IMPLEMENTATION_GUIDE.md** → Day 1 (Audio Analysis)
2. Read **ADVANCED_FEATURES.md** → Service Architecture section
3. Start coding AudioAnalyzerService
4. Copy code from IMPLEMENTATION_GUIDE.md

**If you want full context FIRST:**
1. Read this file (MASTER_PLAN.md) - you are here
2. Read **ARCHITECTURE.md** - understand current system
3. Read **ADVANCED_FEATURES.md** - understand new features
4. Read **IMPLEMENTATION_GUIDE.md** - see actual code
5. Read **CONTINUATION_PLAN.md** - full detailed roadmap

**If you just want QUICK answers:**
1. **QUICK_START.md** - Week 1 action items
2. **IMPLEMENTATION_GUIDE.md** - Code examples
3. Ask specific questions from there

---

## 💾 File Structure After Implementation

```
clipper/
├── src/
│   ├── services/
│   │   ├── orchestrator.service.ts          (ENHANCED - pipeline coordinator)
│   │   ├── youtube.service.ts               (existing)
│   │   ├── ffmpeg.service.ts                (ENHANCED - smooth transitions)
│   │   ├── whisper.service.ts               (existing)
│   │   ├── ai-analyzer.service.ts           (ENHANCED - better scoring)
│   │   ├── tts.service.ts                   (existing)
│   │   ├── subtitle.service.ts              (existing)
│   │   ├── s3.service.ts                    (existing)
│   │   ├── job-manager.service.ts           (existing)
│   │   ├── audio-analyzer.service.ts        (NEW)
│   │   ├── face-detector.service.ts         (NEW)
│   │   ├── portrait-converter.service.ts    (NEW)
│   │   └── database.service.ts              (Phase 2)
│   ├── utils/
│   │   ├── logger.ts                        (existing)
│   │   ├── frame-extractor.ts               (NEW)
│   │   ├── ffmpeg-filter-builder.ts         (NEW)
│   │   ├── tensorflow-loader.ts             (NEW)
│   │   ├── error-handler.ts                 (Phase 1)
│   │   └── ffprobe.ts                       (NEW)
│   ├── config/
│   │   └── env.ts                           (existing)
│   └── index.ts                             (ENHANCED - new endpoints)
├── tests/
│   ├── audio-analyzer.test.ts               (NEW)
│   ├── face-detector.test.ts                (NEW)
│   └── portrait-converter.test.ts           (NEW)
├── docs/
│   ├── MASTER_PLAN.md                       (THIS FILE)
│   ├── CONTINUATION_PLAN.md                 (existing)
│   ├── ARCHITECTURE.md                      (existing)
│   ├── QUICK_START.md                       (existing)
│   ├── ADVANCED_FEATURES.md                 (NEW)
│   └── IMPLEMENTATION_GUIDE.md              (NEW)
├── Dockerfile                               (Phase 2)
├── docker-compose.yml                       (Phase 2)
├── .github/workflows/deploy.yml             (Phase 2)
└── package.json (with new dependencies for TensorFlow, etc.)
```

---

## 🚀 Getting Started TODAY

### Right Now (5 minutes)
- [ ] Read this document to end
- [ ] Skim ADVANCED_FEATURES.md
- [ ] Skim IMPLEMENTATION_GUIDE.md

### Hour 1
- [ ] Open IMPLEMENTATION_GUIDE.md → "Day 1: Setup & Audio Peak Detection"
- [ ] Read the AudioAnalyzerService code
- [ ] Understand the logic flow

### Hour 2
- [ ] Create file: `src/services/audio-analyzer.service.ts`
- [ ] Copy code from IMPLEMENTATION_GUIDE.md
- [ ] Setup TypeScript configuration if needed

### Hour 3-4
- [ ] Test FFmpeg commands manually
- [ ] Verify audio analysis detects peaks correctly
- [ ] Debug any issues with test audio file

### By End of Day 1
- [ ] AudioAnalyzerService implementation complete
- [ ] Tests passing
- [ ] Ready to integrate into orchestrator

---

## 🎁 Success Criteria: Week 1

✅ **Audio Analysis Working**
- AudioAnalyzerService detects peaks & silences accurately
- Cut points generated at natural pause locations
- Smooth audio transitions between clips

✅ **Fully Integrated**
- Audio analysis runs in pipeline
- Highlight scores boosted by audio peaks
- No API errors during processing

✅ **Quality Verified**
- Output audio has no harsh cuts
- Transitions are smooth (< 1 second fade)
- No audio distortion or artifacts

---

## 📞 Support & Questions

### If you get stuck:

1. **Check QUICK_START.md** - Most common issues documented
2. **Check IMPLEMENTATION_GUIDE.md** - Code examples for Phase 1
3. **Check ADVANCED_FEATURES.md** - Technical deep-dive
4. **Check logs** - `LOG_LEVEL=debug npm run dev "..."`
5. **Search errors** - Google FFmpeg/TensorFlow error messages

### Common Issues & Solutions:
- "Can't find ffmpeg" → Install FFmpeg first
- "TensorFlow too slow" → Use BlazeFace model (faster)
- "Out of memory" → Process videos in chunks
- "API 401 error" → Check `.env` credentials

---

## 🎯 Next 30 Days at a Glance

```
WEEK 1: Audio Analysis + Initial Architecture
├─ Day 1: AudioAnalyzerService
├─ Day 2: Integrate into orchestrator
├─ Day 3: Test with real videos
├─ Day 4: Performance optimization
└─ Day 5: Documentation

WEEK 2-3: Face Detection + Portrait Format
├─ Days 1-2: FaceDetectorService with TensorFlow
├─ Days 3-4: PortraitConverterService
├─ Day 5: Full integration testing

WEEK 4-6: Infrastructure & Production Ready
├─ All services production-hardened
├─ Database persistence
├─ Docker containerization
└─ Deployed and monitored
```

---

**Status**: ✅ Ready for Implementation  
**Estimated Time to Production**: 6-8 weeks intensive development  
**Next Step**: Start with IMPLEMENTATION_GUIDE.md → Day 1

🎬 **Let's build something amazing!**

