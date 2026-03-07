# 🚀 Clipper - Quick Start Implementation Guide

## Your Next Action Items (This Week)

### ✅ Pre-Implementation Checklist
- [ ] Review `CONTINUATION_PLAN.md` for full strategy
- [ ] Review `ARCHITECTURE.md` for system design
- [ ] Understand current code structure (7 services)
- [ ] Test current pipeline: `npm run dev "https://www.youtube.com/watch?v=..."`
- [ ] Verify FFmpeg & yt-dlp are installed

### 🔴 CRITICAL - Do These First (Days 1-2)

#### Task 1: Fix Whisper API (Transcription)
**Current Issue**: Returns 401 Unauthorized

**Steps**:
1. Check `.env` file - verify `WHISPER_API_KEY` is set
2. Test the API manually:
   ```bash
   curl -X POST https://api.sumopod.com/v1/audio/transcriptions \
     -H "Authorization: Bearer YOUR_KEY" \
     -F "file=@audio.mp3" \
     -F "model=whisper-1"
   ```
3. If still failing:
   - Option A: Get valid credentials from Sumopod
   - Option B: Switch to OpenAI directly (simpler)
   - Option C: Use local Whisper model (slower but free)

**File to Fix**: `src/services/whisper.service.ts` (line 1-50)

**Code Pattern**:
```typescript
// Current (probably broken)
const response = await axios.post(ENV.WHISPER_API_URL, formData, {
  headers: { 'Authorization': `Bearer ${ENV.WHISPER_API_KEY}` }
});

// Fix: Add error handling + retry logic
if (response.status === 401) {
  log.error('Invalid API key - check WHISPER_API_KEY in .env');
  // Fallback: return dummy transcription or use free service
}
```

---

#### Task 2: Fix AI Analysis (Highlight Detection)
**Current Issue**: Returns 401 Unauthorized

**Steps**:
1. Verify `AI_API_KEY` in `.env`
2. Same test approach as Whisper
3. If credentials valid, check API endpoint format

**File to Fix**: `src/services/ai-analyzer.service.ts`

**Alternative**: If API credentials impossible to fix:
- Implement rule-based fallback: detect silence pauses, audio spikes
- Or use simple heuristics: longer transcript = highlight worthy

---

#### Task 3: Fix TTS Service (Voice Narration)
**Current Issue**: gTTS library implementation is broken (silent audio)

**Choose ONE Provider**:

**Option A: HuggingFace (Recommended - Free tier available)**
```bash
npm install @huggingface/inference
```

**Option B: OpenAI TTS (Paid but reliable)**
```bash
# Already have OpenAI SDK, just configure
```

**Option C: Google Cloud TTS**
```bash
npm install @google-cloud/text-to-speech
```

**File to Fix**: `src/services/tts.service.ts`

📍 **Estimated Effort**: 2 hours per service (Total: 6 hours)

---

### 🟡 PRIORITY 1 - Core Improvements (Days 3-5)

#### Task 4: Enhance Error Handling
**Goal**: Better error messages & graceful degradation

```typescript
// Current: Fails silently or with generic errors
// Target: Specific, actionable error messages

try {
  await service.process();
} catch (error) {
  if (error.code === 'ENOENT') {
    log.error('FFmpeg not found - install with: brew install ffmpeg');
  } else if (error.status === 401) {
    log.error('API authentication failed - check .env');
  } else {
    log.error('Unknown error - enable debug: LOG_LEVEL=debug');
  }
}
```

**Files**: `src/utils/error-handler.ts` (create new), All services

---

#### Task 5: Implement Job Persistence
**Current**: Jobs stored in-memory only (lost on restart)

**Options**:
- **Simple**: Use JSON file (`jobs.json`)
- **Medium**: SQLite database
- **Production**: PostgreSQL/MongoDB

**Recommended for Week 1**: JSON file (fastest to implement)
```typescript
// src/services/job-store.service.ts
class JobStore {
  save(job: JobState) {
    const data = fs.readFileSync('jobs.json');
    const jobs = JSON.parse(data);
    jobs[job.jobId] = job;
    fs.writeFileSync('jobs.json', JSON.stringify(jobs));
  }
}
```

---

#### Task 6: Add New API Endpoints
**Current**: Only 2 endpoints (clip, status)

**Add These**:
```bash
# File download
GET /api/files/:jobId/video
GET /api/files/:jobId/thumbnail

# Job history
GET /api/jobs                    # List all jobs
DELETE /api/jobs/:jobId          # Cancel job

# Health check
GET /api/health                  # Service status

# Webhook delivery
POST /api/webhook/:jobId         # Retry failed webhook
```

---

## 📋 Implementation Roadmap (Week 1)

### Monday & Tuesday
- [ ] Fix Whisper & AI APIs (or implement fallback)
- [ ] Fix TTS service
- [ ] Update `.env` with working credentials
- [ ] Test full pipeline end-to-end

### Wednesday
- [ ] Improve error handling across all services
- [ ] Add better logging
- [ ] Create error handler utility

### Thursday
- [ ] Implement job persistence (JSON file)
- [ ] Add new API endpoints (files, jobs list)
- [ ] Test API with Postman

### Friday
- [ ] Write comprehensive documentation
- [ ] Create API examples
- [ ] Deploy locally & test thoroughly
- [ ] Plan Week 2 infrastructure tasks

---

## 🧪 Testing Checklist

### Unit Tests (Add to `package.json` scripts)
```json
{
  "scripts": {
    "test": "jest",
    "test:watch": "jest --watch",
    "test:coverage": "jest --coverage"
  }
}
```

### Manual Testing (Do These)
```bash
# 1. Test default credentials
npm run dev "https://www.youtube.com/watch?v=rEq1Z0bjdwc"

# 2. Test API endpoint
curl -X POST http://localhost:8080/api/clip \
  -H "Content-Type: application/json" \
  -d '{"url":"https://www.youtube.com/watch?v=rEq1Z0bjdwc"}'

# 3. Check status
curl http://localhost:8080/api/status/{jobId}

# 4. Verify output
ls -lah output/
ls -lah temp/
```

---

## 💡 Important Tips

### Environment Variables
```bash
# Create .env file with these:
PORT=8080
NODE_ENV=development
LOG_LEVEL=info

# APIs (GET VALID KEYS!)
WHISPER_API_KEY=sk-...
AI_API_KEY=...

# Storage
USE_BACKGROUND_MUSIC=true
OUTPUT_DIR=./output
TEMP_DIR=./temp
MAX_DURATION=600
```

### Debugging Commands
```bash
# Verbose logging
LOG_LEVEL=debug npm run dev "..."

# Check if FFmpeg installed
ffmpeg -version

# Check if yt-dlp installed
yt-dlp --version

# Monitor file sizes
watch ls -lah output/ temp/
```

### Quick Fixes for Common Errors
```
Error: "Cannot find ffmpeg"
→ Fix: brew install ffmpeg (macOS) or apt install ffmpeg (Linux)

Error: "401 Unauthorized"
→ Fix: Check API keys in .env, get valid credentials

Error: "Cannot write to output directory"
→ Fix: chmod 755 output/ && mkdir -p temp/

Error: "ENOENT: no such file or directory"
→ Fix: mkdir -p output temp logs
```

---

## 📚 Useful Resources

### FFmpeg
- **Cut video**: `ffmpeg -ss START -to END -i input.mp4 output.mp4`
- **Concat videos**: Use concat demuxer (see `ffmpeg.service.ts`)
- **Add subtitles**: `ffmpeg -i video.mp4 -vf "ass=subtitles.ass" output.mp4`

### yt-dlp
- **Download**: `yt-dlp https://youtube.com/watch?v=...`
- **List formats**: `yt-dlp -F https://youtube.com/watch?v=...`
- **Best quality**: `yt-dlp -f bestvideo+bestaudio https://youtube.com/watch?v=...`

### APIs
- **Whisper**: https://platform.openai.com/docs/guides/speech-to-text
- **OpenAI GPT**: https://platform.openai.com/docs/guides/gpt-4
- **HuggingFace**: https://huggingface.co/docs/transformers

---

## 🎯 Success Criteria

After implementing these tasks, you should have:

✅ **Fully Functional Pipeline**
- Download → Transcribe → Analyze → Render → Complete

✅ **Robust Error Handling**
- Graceful degradation when APIs fail
- Clear error messages in logs

✅ **Persistent Job Storage**
- Jobs survive server restart
- Job history available via API

✅ **Complete API**
- Trigger jobs
- Monitor progress
- Download results
- View history

✅ **Ready for Production**
- 99% uptime
- Handles concurrent requests
- Clean output files
- Automatic cleanup

---

## 📞 When You Need Help

### Check These First
1. Logs: `tail -f logs/app.log` | `LOG_LEVEL=debug npm run dev`
2. Environment: `cat .env` (verify all keys are set)
3. Services: `curl http://localhost:8080/api/health`
4. Disk space: `df -h` (need 2GB+ free)
5. Running processes: `ps aux | grep npm`

### Common Issues Solved
- **API timeout**: Increase timeout in axios config
- **Memory leak**: Restart server daily, implement cleanup
- **Slow transcription**: Use batch mode, process at night
- **Large outputs**: Enable compression, delete old files

---

**Ready to start? Pick Task 1 and begin! 🚀**

Last Updated: March 6, 2026
