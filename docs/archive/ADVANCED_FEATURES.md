# 🎬 Clipper - Advanced Features Plan
## Portrait + Audio Analysis + Subject Centering

**Date**: March 6, 2026  
**Status**: Architecture & Planning Phase  
**Priority**: High Impact (Significantly Improves Video Quality)

---

## 🎯 New Requirements Overview

### 1. **Audio Analysis (Smooth Cutting)**
- Detect audio peaks (loud moments = likely highlights)
- Detect silence (dead air = cut here)
- Create smooth transitions between segments
- Better highlight detection than just AI analysis

### 2. **Portrait Format Video**  
- Convert all output videos to 9:16 aspect ratio (vertical)
- Responsive reframing for mobile viewing
- Maintain video quality during transformation

### 3. **Subject Centering (Face Detection)**
- Automatically detect & track faces in video
- Keep subjects centered in portrait frame
- Dynamic framing (pan/zoom to follow face)
- Fallback to center crop if no face detected

---

## ✅ Confirmed API Credentials & Specs

### Valid Sumopod APIs (All Tested ✅)
```env
# Visual Analysis (Multimodal Vision AI)
AI_API_BASE_URL=https://ai.sumopod.com/v1
AI_API_KEY=replace-with-real-key
AI_MODEL=seed-2-0-mini-free        # For image analysis

# Audio Transcription & Analysis
WHISPER_API_URL=https://ai.sumopod.com/v1
WHISPER_API_KEY=replace-with-real-key
WHISPER_MODEL=whisper-1            # For audio analysis

# Text-to-Speech (HuggingFace)
HUGGINGFACE_API_KEY=replace-with-real-key
```

### New Dependencies to Add
```json
{
  "@tensorflow/tfjs": "^4.x",
  "@tensorflow/tfjs-node": "^4.x",
  "@tensorflow-models/face-detection": "^1.x",
  "@tensorflow-models/coco-ssd": "^2.x",
  "fluent-ffmpeg": "^2.1.3"  (already have)
}
```

---

## 🏗️ NEW Pipeline Architecture

```
YouTube URL
    ↓
[STEP 1] Download Video (existing)
    ↓
[STEP 2] Extract Audio (existing)
    ↓
┌─────────────────────────────────┐
│  [STEP 3a] Audio Analysis       │ ← NEW
│  • Detect peaks (0-1 scale)     │
│  • Detect silence (thresholds)  │
│  • Generate audio segments      │
└─────────────────────────────────┘
    ↓
┌─────────────────────────────────┐
│  [STEP 3b] Transcription        │
│  (via Whisper API - working)    │
└─────────────────────────────────┘
    ↓
┌─────────────────────────────────┐
│  [STEP 4] Visual Analysis       │ ← ENHANCED
│  • AI Vision (seed-2-0-mini)    │
│  • Extract key scenes           │
│  • Score visual interest        │
└─────────────────────────────────┘
    ↓
┌─────────────────────────────────┐
│  [STEP 4b] Face Detection       │ ← NEW
│  • Run TensorFlow face-detection│
│  • Track subject position       │
│  • Generate framing instructions│
└─────────────────────────────────┘
    ↓
┌─────────────────────────────────┐
│  [STEP 5] Highlight Detection   │
│  • Combine: audio + visual + AI │
│  • Score each segment           │
│  • Select top segments          │
└─────────────────────────────────┘
    ↓
┌─────────────────────────────────┐
│  [STEP 6] Crop to Portrait      │ ← NEW
│  • Resize to 9:16 aspect ratio │
│  • Apply smart cropping/panning │
│  • Center on detected faces     │
└─────────────────────────────────┘
    ↓
[STEP 7] Cut Segments (with smooth audio)
    ↓
[STEP 8] Concatenate with crossfade
    ↓
[STEP 9] Add TTS Narration (HuggingFace)
    ↓
[STEP 10] Add Subtitles (SRT format)
    ↓
[STEP 11] Final Render (portrait + audio)
    ↓
[STEP 12] Generate Thumbnail (portrait)
    ↓
✅ Output: Portrait video with centered subjects
```

---

## 📊 Service Layer Breakdown

### NEW SERVICES TO CREATE

#### 1. **AudioAnalyzer Service** (`src/services/audio-analyzer.service.ts`)
**Purpose**: Detect audio peaks & silence for smooth transitions

```typescript
interface AudioPeak {
  timestamp: number;      // seconds
  intensity: number;      // 0-1 scale
  duration: number;       // seconds
  type: 'peak' | 'silence' | 'speech';
}

interface AudioAnalysis {
  peaks: AudioPeak[];                    // Loud moments
  silences: AudioPeak[];                 // Silent segments
  avgIntensity: number;
  suggestedCutPoints: number[];          // Best places to cut
}

class AudioAnalyzerService {
  static async analyzeAudio(audioPath: string): Promise<AudioAnalysis>
  static detectPeaks(audioPath: string, threshold?: number): Promise<AudioPeak[]>
  static detectSilence(audioPath: string, threshold?: number): Promise<AudioPeak[]>
  static generateCutPoints(peaks: AudioPeak[]): number[]
}
```

**Implementation Approach**:
- Use FFmpeg audio filter to convert to frequency spectrum
- Analyze dB levels across timeline
- Find peaks > threshold & silences < threshold

#### 2. **Face Detector Service** (`src/services/face-detector.service.ts`)
**Purpose**: Detect faces & generate portrait cropping instructions

```typescript
interface FaceDetection {
  timestamp: number;      // seconds
  faces: Array<{
    x: number;           // frame position (0-1)
    y: number;
    width: number;       // as fraction of frame
    height: number;
    confidence: number;  // 0-1
  }>;
  primarySubject: number; // index of main face
}

interface FramingInstruction {
  timestamp: number;
  cropBox: {
    x: number;  // center X in original 16:9 frame
    y: number;  // center Y
    width: number;  // width of portrait crop
    height: number; // height
  };
  transition: 'cut' | 'pan' | 'zoom';  // how to transition
  duration: number;  // seconds to apply
}

class FaceDetectorService {
  static async detectFaces(videoPath: string): Promise<FaceDetection[]>
  static generateFraming(detections: FaceDetection[]): FramingInstruction[]
  static applyFraming(videoPath: string, framing: FramingInstruction[]): Promise<string>
}
```

**Implementation Approach**:
- Sample frames every 0.5 seconds (not every frame = faster)
- Run TensorFlow face-detection model
- Generate smooth panning between face positions

#### 3. **Portrait Converter Service** (`src/services/portrait-converter.service.ts`)
**Purpose**: Convert 16:9 video to 9:16 portrait format

```typescript
interface PortraitOptions {
  targetWidth: number;   // typically 1080px
  targetHeight: number;  // typically 1920px
  smartCrop: boolean;    // use face detection
  fillMode: 'blur' | 'black' | 'stretch'; // if no face
}

class PortraitConverterService {
  static async convertToPortrait(
    videoPath: string, 
    facingFraming?: FramingInstruction[],
    options?: PortraitOptions
  ): Promise<string>
  
  static generatePortraitFFmpegFilter(
    framing: FramingInstruction[]
  ): string
}
```

**Implementation Approach**:
- Create FFmpeg filter chain for cropping
- Apply smooth easing between pan positions
- Use `pan` and `zoom` filters for dynamic framing

### ENHANCED EXISTING SERVICES

#### AI Analyzer Service (Enhanced)
```typescript
// Add visual scene scoring
interface VisualAnalysis {
  scenes: Array<{
    timestamp: number;
    type: string;          // 'interview' | 'action' | 'reaction' | etc
    interest: number;      // 0-1 score
    description: string;
  }>;
  keyMoments: number[];    // timestamps of visually interesting moments
}

class AIAnalyzerService {
  static async analyzeVisual(
    previewImageUrl: string,
    context: string
  ): Promise<VisualAnalysis>
}
```

#### Orchestrator Service (Enhanced)
```typescript
// NEW parallel processing
async processYouTubeToClip(youtubeUrl, jobId, webhookUrl) {
  // Run audio + face detection in PARALLEL
  const [audioAnalysis, faceDetections] = await Promise.all([
    AudioAnalyzerService.analyzeAudio(audioPath),
    FaceDetectorService.detectFaces(videoPath)
  ]);
  
  // Generate framing instructions
  const framing = FaceDetectorService.generateFraming(faceDetections);
  
  // Combine scores: audio + visual + AI
  const highlights = this.combineScores(
    audioAnalysis,
    visualAnalysis,
    aiHighlights
  );
  
  // Convert to portrait with smart cropping
  const portraitVideo = await PortraitConverterService.convertToPortrait(
    renderedVideo,
    framing
  );
}
```

#### FFmpeg Service (Enhanced)
```typescript
class FFmpegService {
  // NEW methods
  static async applyPortraitCrop(
    videoPath: string,
    cropFilter: string
  ): Promise<string>
  
  static async applySmoothCrossfade(
    segments: string[],
    fadeDuration: number
  ): Promise<string>
}
```

---

## 🎯 Implementation Tasks

### PHASE 1: Audio Analysis (3-4 days)
**Goal**: Detect peaks & silence for smooth cuts

#### Task 1.1: Audio Peak Detection
```typescript
// Analyze audio spectrum
ffmpeg -i audio.mp3 -filter_complex "
  [0:a]showspeqat=size=1920x1080:s=0.5:freq=0|24|1:chlayout=stereo[out]
" -f image2 -vf fps=2 peak_%03d.png

// Parse images to get dB levels over time
// Identify peaks > threshold (e.g., -20dB)
// Return array of {timestamp, intensity, duration}
```

**Files to Create**:
- `src/services/audio-analyzer.service.ts`
- `src/utils/ffprobe.ts` (helper for audio extraction)
- Tests: `tests/audio-analyzer.test.ts`

#### Task 1.2: Smooth Cut Points Algorithm
- Input: Array of peaks + silences
- Output: Optimal cut points that avoid mid-word cuts
- Logic: Cut at silence boundaries, prefer 0.5-1 sec silence gaps

#### Task 1.3: Test with Sample Audio
- Create test video with mixed dialogue, silence, music
- Verify peak detection accuracy
- Fine-tune thresholds

**Estimated Effort**: 3-4 days

---

### PHASE 2: Face Detection & Framing (4-5 days)
**Goal**: Detect faces & generate portrait cropping instructions

#### Task 2.1: Setup TensorFlow & Face Detection
```bash
npm install @tensorflow/tfjs @tensorflow/tfjs-node @tensorflow-models/face-detection
npm install @tensorflow-models/coco-ssd  # For object detection fallback
```

#### Task 2.2: Implement Face Detector Service
```typescript
// Frame sampling strategy
// Every 0.5 seconds (2 fps), extract frame
ffmpeg -i video.mp4 -vf "fps=2" frames/frame_%05d.jpg

// Run Face Detection on each frame
const faces = await faceDetector.estimateFaces(imageData);

// Generate framing instructions
// Smooth transition between detected face positions
```

**Key Decisions**:
- Sample rate: 2 fps (every 0.5 sec) = balance speed vs accuracy  
- Model: Use `BlazeFace` (fast) or `FaceMesh` (detailed)
- Fallback: If no face, default to center crop

#### Task 2.3: Generate Framing FFmpeg Filter
```typescript
// Output: Complex FFmpeg filter string
// Example: "crop=1080:1920:420:0,pad=1080:1920:0:0:color=black"
// Or with panning: "[v]split=N[s0][s1]...[s0]crop=...[out0];..."

// Support transitions:
// - 'cut': immediate change
// - 'pan': smooth panning (1-2 sec)
// - 'zoom': zoom in/out to follow movement
```

**Files to Create**:
- `src/services/face-detector.service.ts`
- `src/utils/tensorflow-loader.ts` (lazy load model)
- `src/utils/frame-extractor.ts`
- Tests: `tests/face-detector.test.ts`

**Estimated Effort**: 4-5 days

---

### PHASE 3: Portrait Converter (3-4 days)
**Goal**: Convert 16:9 to 9:16 with smart cropping

#### Task 3.1: Portrait Converter Service
```typescript
// Main logic:
// 1. If face framing provided: apply dynamic crop boxes
// 2. If no face: use center crop with blur sides (optional)
// 3. Apply smooth transitions between crop zones

// Output resolution: 1080x1920 (standard vertical)
```

#### Task 3.2: FFmpeg Filter Chain
```bash
# Build complex filter:
# - Sample frame per 0.5 sec
# - Crop box for that interval
# - Smooth transition between boxes
# - Fill mode (blur/black) for edges

ffmpeg -i input.mp4 \
  -vf "[0:v]fps=2,crop=1080:1920:420:0[out1];[out1]fps=25[final]" \
  -c:v libx264 output.mp4
```

#### Task 3.3: Performance Optimization
- Cache face detections (compute once)
- Process video in chunks if > 30 min
- Use hardware acceleration (NVIDIA/Intel)

**Files to Create**:
- `src/services/portrait-converter.service.ts`
- `src/utils/ffmpeg-filter-builder.ts`
- Tests: `tests/portrait-converter.test.ts`

**Estimated Effort**: 3-4 days

---

### PHASE 4: Pipeline Integration (2-3 days)
**Goal**: Wire everything into orchestrator

#### Task 4.1: Update Orchestrator
```typescript
// Add new steps to pipeline:
// 1. Audio analysis (parallel with face detection)
// 2. Combine scores (audio + visual + AI)
// 3. Apply portrait conversion
// 4. Render final output
```

#### Task 4.2: Score Combination Algorithm
```typescript
// Scoring weights:
const AUDIO_WEIGHT = 0.3;     // Peak intensity
const VISUAL_WEIGHT = 0.3;    // AI scene interest
const TRANSCRIPTION_WEIGHT = 0.2; // Keyword matching
const FACE_WEIGHT = 0.2;      // Face prominence

// Final highlight score = weighted average of all scores
```

#### Task 4.3: Test Full Pipeline
- End-to-end test with sample YouTube video
- Verify audio peaks detected correctly
- Verify faces tracked smoothly  
- Verify portrait output looks good

**Files to Modify**:
- `src/services/orchestrator.service.ts`
- `src/index.ts` (add new endpoints for testing)

**Estimated Effort**: 2-3 days

---

## 📈 Updated Timeline

```
WEEK 1: Foundation
├─ Day 1-2: Setup TensorFlow, implement audio analyzer
├─ Day 3: Test audio analysis, integrate into pipeline
└─ Day 4-5: Code review, documentation

WEEK 2: Face Detection  
├─ Day 1-2: Implement face detector service
├─ Day 3: Generate framing instructions
├─ Day 4: Test face tracking on sample videos
└─ Day 5: Optimize performance

WEEK 3: Portrait Conversion
├─ Day 1-2: Implement portrait converter
├─ Day 3: Build FFmpeg filter chains
├─ Day 4: Test portrait output quality
└─ Day 5: Integration testing

WEEK 4: Polish & Deployment
├─ Day 1: Full pipeline testing
├─ Day 2-3: Performance optimization
├─ Day 4: Documentation & examples
└─ Day 5: Deploy & monitor
```

---

## 🧪 Testing Strategy

### Unit Tests (Jest)
```typescript
// AudioAnalyzer.test.ts
describe('AudioAnalyzer', () => {
  test('should detect peaks correctly', async () => {
    const analysis = await AudioAnalyzerService.analyzeAudio(testAudio);
    expect(analysis.peaks.length).toBeGreaterThan(0);
    expect(analysis.peaks[0].intensity).toBeGreaterThan(0.5);
  });
});

// FaceDetector.test.ts
describe('FaceDetector', () => {
  test('should detect faces in video', async () => {
    const detections = await FaceDetectorService.detectFaces(testVideo);
    expect(detections.length).toBeGreaterThan(0);
  });
});
```

### Integration Tests
```typescript
// Full pipeline test
test('should process video to portrait clip', async () => {
  const result = await Orchestrator.processYouTubeToClip(testUrl, jobId);
  
  // Verify output
  expect(fs.existsSync(result.videoPath)).toBe(true);
  
  // Verify portrait aspect ratio
  const stats = await getVideoStats(result.videoPath);
  expect(stats.width / stats.height).toBeLessThan(1); // portrait
});
```

### Performance Tests
```typescript
// Benchmark audio analysis
console.time('audio-analysis');
await AudioAnalyzerService.analyzeAudio(longVideo);  // 30 min
console.timeEnd('audio-analysis');
// Target: < 60 seconds for 30-min video
```

---

## 🚀 Implementation Checklist

### Audio Analysis
- [ ] Create AudioAnalyzerService skeleton
- [ ] Implement FFmpeg audio spectrum extraction
- [ ] Implement peak detection algorithm
- [ ] Implement silence detection algorithm
- [ ] Add unit tests
- [ ] Integrate into orchestrator
- [ ] Test with real YouTube video

### Face Detection
- [ ] Install TensorFlow + face-detection
- [ ] Create FaceDetectorService skeleton
- [ ] Implement frame extraction
- [ ] Load face detection model
- [ ] Implement face tracking algorithm
- [ ] Generate framing instructions
- [ ] Add unit tests
- [ ] Test with different video types (interview, action, etc.)

### Portrait Conversion
- [ ] Create PortraitConverterService skeleton
- [ ] Build FFmpeg filter chain builder
- [ ] Implement portrait crop logic
- [ ] Test with smooth panning
- [ ] Optimize for performance
- [ ] Add quality tests (no artifacts, smooth transitions)

### Integration
- [ ] Update Orchestrator to call all services
- [ ] Implement score combination algorithm
- [ ] End-to-end test
- [ ] Performance benchmarking
- [ ] Error handling & fallbacks
- [ ] Documentation

---

## 💾 Database Schema Changes

### Job Model (Add Portrait Flag)
```typescript
interface JobState {
  jobId: string;
  youtubeUrl: string;
  
  // NEW: Portrait rendering options
  format: 'landscape' | 'portrait';  // default: 'portrait'
  smartCropping: boolean;             // use face detection
  cropStyle: 'center' | 'face-tracking' | 'blur-sides';
  
  // Processing tracking
  status: JobStatus;
  progress: number;
  processingSteps: {
    audioAnalysis?: { completed: boolean; time: number; };
    faceDetection?: { completed: boolean; time: number; };
    portraitConversion?: { completed: boolean; time: number; };
  };
}
```

---

## 📊 Performance Targets

| Task | Current | Target | Method |
|------|---------|--------|--------|
| Audio Analysis (30 min) | N/A | < 60s | FFmpeg spectrum + loop |
| Face Detection (30 min) | N/A | < 120s | 2fps sampling + TF |
| Portrait Conversion | N/A | < 60s | FFmpeg filter chain |
| **Total Pipeline** | ~52s | < 5 min | Parallel processing |

---

## 🔧 Configuration Options

### New Environment Variables
```env
# Audio Analysis
AUDIO_PEAK_THRESHOLD=-20        # dB level for peak detection
AUDIO_SILENCE_THRESHOLD=-45     # dB for silence detection
AUDIO_MIN_PEAK_DURATION=0.1     # seconds
AUDIO_MIN_SILENCE_DURATION=0.2  # seconds

# Face Detection
FACE_DETECTION_SAMPLE_RATE=2    # fps (frames per second)
FACE_DETECTION_CONFIDENCE=0.5   # 0-1 threshold
FACE_DETECTION_MODEL=blazeface  # or facemesh

# Portrait Converter
PORTRAIT_WIDTH=1080             # pixels
PORTRAIT_HEIGHT=1920            # pixels
PORTRAIT_FILL_MODE=blur         # blur|black|stretch
PORTRAIT_TRANSITION_TIME=1      # seconds for panning
PORTRAIT_PANNING_SMOOTHNESS=0.8 # 0-1, higher = smoother

# Scoring
AUDIO_SCORE_WEIGHT=0.3
VISUAL_SCORE_WEIGHT=0.3
TRANSCRIPTION_SCORE_WEIGHT=0.2
FACE_SCORE_WEIGHT=0.2
```

---

## 🎁 Deliverables

### After Phase 1 (Audio Analysis)
✅ AudioAnalyzer service working  
✅ Peak detection accurate  
✅ Silence detection accurate  
✅ Smooth cut points generated

### After Phase 2 (Face Detection)
✅ Face detector running  
✅ Face tracking smooth  
✅ Framing instructions generated  
✅ Performance optimized

### After Phase 3 (Portrait Conversion)
✅ Videos converted to portrait  
✅ Subjects centered in frame  
✅ Smooth transitions  
✅ No artifacts or quality loss

### After Phase 4 (Integration)
✅ Full pipeline working  
✅ All services integrated  
✅ Performance benchmarks met  
✅ Production-ready

---

## 📞 Risk & Mitigation

| Risk | Impact | Mitigation |
|------|--------|-----------|
| TensorFlow model too slow | High | Use BlazeFace, optimize sampling rate |
| Face detection accuracy low | Medium | Add COCO-SSD fallback for people detection |
| FFmpeg filter complexity | Medium | Build filter builder utility, test thoroughly |
| Memory issues with long videos | High | Process in chunks, release frames after analysis |
| Quality loss in portrait crop | Medium | Test multiple algorithms, use high bitrate |

---

## 📚 Reference Resources

### Audio Analysis
- FFmpeg Audio Filters: https://ffmpeg.org/ffmpeg-filters.html#showspeqat
- Audio Peak Detection: https://en.wikipedia.org/wiki/Peak_detection

### TensorFlow & Face Detection
- TensorFlow.js: https://js.tensorflow.org/
- Face Detection Models: https://github.com/tensorflow/tfjs-models/tree/master/face-detection
- COCO-SSD: https://github.com/tensorflow/tfjs-models/tree/master/coco-ssd

### Video Processing
- FFmpeg Crop Filter: https://ffmpeg.org/ffmpeg-filters.html#crop_002c-mcrop
- FFmpeg Pan Filter: https://ffmpeg.org/ffmpeg-filters.html#pan_002c-apad
- Video Aspect Ratios: https://en.wikipedia.org/wiki/Aspect_ratio_(image)

---

**Status**: Ready for Implementation  
**Next Step**: Start Phase 1 (Audio Analysis)  
**Estimated Total Effort**: 12-14 days (2 weeks intensive)

