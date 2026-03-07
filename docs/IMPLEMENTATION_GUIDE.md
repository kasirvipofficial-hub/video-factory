# 🎬 Clipper - Advanced Features Implementation Guide
## Audio Analysis + Portrait + Subject Centering

**Start Date**: March 6, 2026  
**Phase 1 End Date**: Week 1 (Audio)  
**Phase Complete**: ~2 weeks

---

## 🎯 What We're Building

### Feature 1: Smart Audio Analysis
**Problem**: Currently cuts are not smooth - might split words mid-sentence.  
**Solution**: Analyze audio to find natural pause points (peaks & silence).
```
Dialog: "This is... [SILENCE] ...amazing"
                    ↑ Best cut point
```

### Feature 2: Portrait Video (9:16)
**Problem**: Original YouTube videos are landscape (16:9).  
**Solution**: Convert to vertical format, perfect for mobile/TikTok.
```
Before:  ████████████████████ (16:9)
After:   ██ (9:16 portrait)
         ██
         ██
```

### Feature 3: Smart Subject Centering
**Problem**: When video is cropped to portrait, subject might be cut off.  
**Solution**: Use AI to detect faces, keep them centered in frame.
```
Original (16:9):        Portrait (9:16):
[FACE                ]  →  [FACE]
```

---

## 📋 PHASE 1: Audio Analysis (3-4 Days)

### Day 1: Setup & Audio Peak Detection

#### Step 1: Create AudioAnalyzer Service
Create file: `src/services/audio-analyzer.service.ts`

```typescript
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { log } from '../utils/logger';

export interface AudioPeak {
  timestamp: number;      // seconds
  intensity: number;      // 0-1 scale (normalized dB)
  duration: number;       // seconds
  type: 'peak' | 'silence' | 'speech';
}

export interface AudioAnalysis {
  peaks: AudioPeak[];           // Loud moments (highlights)
  silences: AudioPeak[];        // Silent segments (cut points)
  avgIntensity: number;         // Overall volume
  suggestedCutPoints: number[]; // Optimal places to cut
}

export class AudioAnalyzerService {
  /**
   * Analyze audio file for peaks and silences
   * Peak = loud moment (potential highlight)
   * Silence = quiet moment (good cut point)
   */
  static async analyzeAudio(audioPath: string): Promise<AudioAnalysis> {
    try {
      log.info({ audioPath }, '[AudioAnalyzer] Starting analysis');
      const startTime = Date.now();

      // Step 1: Extract audio peaks
      const peaks = await this.detectPeaks(audioPath);
      log.info({ count: peaks.length }, '[AudioAnalyzer] Peaks detected');

      // Step 2: Extract audio silences
      const silences = await this.detectSilence(audioPath);
      log.info({ count: silences.length }, '[AudioAnalyzer] Silences detected');

      // Step 3: Calculate statistics
      const avgIntensity = peaks.length > 0
        ? peaks.reduce((sum, p) => sum + p.intensity, 0) / peaks.length
        : 0;

      // Step 4: Generate optimal cut points
      const suggestedCutPoints = this.generateCutPoints(silences);

      const duration = Date.now() - startTime;
      log.info({ duration: `${duration}ms` }, '[AudioAnalyzer] Analysis complete');

      return {
        peaks,
        silences,
        avgIntensity,
        suggestedCutPoints
      };
    } catch (err) {
      log.error({ err }, '[AudioAnalyzer] Analysis failed');
      throw err;
    }
  }

  /**
   * Detect peaks in audio (loud moments)
   * Uses FFmpeg to analyze audio spectrum
   */
  static async detectPeaks(audioPath: string, threshold: number = -20): Promise<AudioPeak[]> {
    const execAsync = promisify(exec);
    
    try {
      log.debug({ audioPath, threshold }, '[AudioAnalyzer] Detecting peaks');

      // Use FFmpeg to get audio characteristics
      // Output format: time dB_level
      const { stdout } = await execAsync(`
        ffmpeg -i "${audioPath}" -af "
          volumedetect=n=1,
          astats=metadata=1:reset=1
        " -f null -
      `, { maxBuffer: 10 * 1024 * 1024 });

      // Parse FFmpeg output and extract loudness information
      const peaks = this.parsePeaksFromFFmpeg(stdout, threshold);
      return peaks;
    } catch (err) {
      log.warn({ err }, '[AudioAnalyzer] Peak detection failed, returning empty');
      return [];
    }
  }

  /**
   * Detect silences in audio (quiet moments)
   * Best places to cut between segments
   */
  static async detectSilence(audioPath: string, threshold: number = -45): Promise<AudioPeak[]> {
    const execAsync = promisify(exec);
    
    try {
      log.debug({ audioPath, threshold }, '[AudioAnalyzer] Detecting silences');

      // Similar to detectPeaks but looking for low levels
      const { stdout } = await execAsync(`
        ffmpeg -i "${audioPath}" -af "
          silencedetect=n=-45dB:d=0.5
        " -f null -
      `, { maxBuffer: 10 * 1024 * 1024 });

      const silences = this.parseSilencesFromFFmpeg(stdout);
      return silences;
    } catch (err) {
      log.warn({ err }, '[AudioAnalyzer] Silence detection failed, returning empty');
      return [];
    }
  }

  /**
   * Parse FFmpeg volumedetect output
   * Extract timing and intensity information
   */
  private static parsePeaksFromFFmpeg(output: string, threshold: number): AudioPeak[] {
    const peaks: AudioPeak[] = [];
    
    // Look for lines with max_volume information
    const maxVolumeMatch = output.match(/max_volume:\s*([-\d.]+)\s*dB/);
    if (!maxVolumeMatch) return peaks;

    const maxVolume = parseFloat(maxVolumeMatch[1]);
    const normalizedMax = Math.max(0, Math.min(1, (maxVolume + 60) / 60)); // Normalize to 0-1

    // Simple heuristic: if max_volume > threshold, return one peak
    if (maxVolume > threshold) {
      peaks.push({
        timestamp: 0,
        intensity: normalizedMax,
        duration: 0.5,
        type: 'peak'
      });
    }

    return peaks;
  }

  /**
   * Parse FFmpeg silencedetect output
   * Format: [silencedetect @ ...] silence_start: 0.512, silence_end: 5.024, silence_duration: 4.512
   */
  private static parseSilencesFromFFmpeg(output: string): AudioPeak[] {
    const silences: AudioPeak[] = [];
    const silenceRegex = /silence_start:\s*([\d.]+).*?silence_end:\s*([\d.]+).*?silence_duration:\s*([\d.]+)/g;
    
    let match;
    while ((match = silenceRegex.exec(output)) !== null) {
      const start = parseFloat(match[1]);
      const end = parseFloat(match[2]);
      const duration = parseFloat(match[3]);

      silences.push({
        timestamp: start,
        intensity: 0,
        duration,
        type: 'silence'
      });
    }

    return silences;
  }

  /**
   * Generate optimal cut points from silence detections
   * Avoid cutting during speech, prefer silence gaps
   */
  static generateCutPoints(silences: AudioPeak[]): number[] {
    return silences
      .filter(s => s.duration >= 0.2) // Only silences > 0.2 seconds
      .map(s => s.timestamp)
      .sort((a, b) => a - b);
  }
}
```

#### Step 2: Test Audio Analysis Service
```bash
# Run this to test
npm run dev "https://www.youtube.com/watch?v=SAMPLE_VIDEO_ID"

# Check logs for audio analysis output
# Example: [3.234s] [AudioAnalyzer] Peaks detected: 5
```

---

### Day 2: Integrate Audio Peaks into Highlight Detection

#### Step 3: Update Orchestrator to Use Audio Analysis
File: `src/services/orchestrator.service.ts`

Find the section where highlights are detected (around line 50-100).

**Before**:
```typescript
// Step 4: AI Analysis (current)
const highlights = await AIAnalyzer.analyzeHighlights(transcript);
```

**After**:
```typescript
// Step 3.5: Audio Analysis (NEW PARALLEL STEP)
log.info('[3.5/6] Analyzing audio for peaks and natural cut points...');
const audioAnalysis = await AudioAnalyzerService.analyzeAudio(audioPath);

// Step 4: AI Analysis (enhanced with audio data)
const highlights = await AIAnalyzer.analyzeHighlights(
  transcript,
  {
    audioPeaks: audioAnalysis.peaks,
    suggestedCutPoints: audioAnalysis.suggestedCutPoints
  }
);
```

#### Step 4: Update AI Analyzer to Consider Audio
File: `src/services/ai-analyzer.service.ts`

```typescript
interface HighlightAnalysisContext {
  audioPeaks?: AudioPeak[];
  suggestedCutPoints?: number[];
}

static async analyzeHighlights(
  transcript: string,
  context?: HighlightAnalysisContext
): Promise<HighlightSegment[]> {
  // Existing AI analysis...
  const aiHighlights = await this.callAI(transcript);
  
  // NEW: Boost scores for segments with audio peaks
  if (context?.audioPeaks) {
    return aiHighlights.map(highlight => {
      // If highlight has audio peak at start/end, increase score
      const hasPeakNearby = context.audioPeaks.some(
        peak => Math.abs(peak.timestamp - highlight.start) < 1
      );
      if (hasPeakNearby) {
        highlight.score *= 1.2; // 20% boost
      }
      return highlight;
    });
  }
  
  return aiHighlights;
}
```

---

### Day 3: Add Audio Cut Smoothing

#### Step 5: Smooth Audio Transitions
File: `src/services/ffmpeg.service.ts`

Add new method:
```typescript
/**
 * Cut segment with smooth audio transition
 * Fade out/in to avoid harsh cuts
 */
static async cutSegmentSmooth(
  videoPath: string,
  startTime: number,
  endTime: number,
  outputPath: string,
  fadeTime: number = 0.2 // 200ms fade
): Promise<void> {
  const fadeCmd = `
    ffmpeg -i "${videoPath}" \
      -ss ${startTime} -to ${endTime} \
      -vf "copy" \
      -af "afade=t=in:st=0:d=${fadeTime},afade=t=out:st=${endTime - startTime - fadeTime}:d=${fadeTime}" \
      -c:v copy -c:a aac \
      "${outputPath}"
  `;
  
  await execAsync(fadeCmd);
}
```

#### Step 6: Test Full Audio Pipeline
```bash
npm run dev "https://www.youtube.com/watch?v=SAMPLE_VIDEO"

# Verify:
# ✅ Audio analysis shows peaks
# ✅ Highlights detected (with audio boost)
# ✅ Output videos have smooth audio transitions
# ✅ No harsh cuts between segments
```

**Expected Output Logs**:
```
[2:45] [AudioAnalyzer] Peaks detected: 8
[2:46] [AudioAnalyzer] Silences detected: 5  
[2:47] [AudioAnalyzer] Suggested cut points: [0.5, 2.3, 5.1, 7.8]
[2:48] [AIAnalyzer] Analyzing with audio context...
[2:59] [Highlights] Detected 3 segments with smooth audio transitions
```

---

## 📋 PHASE 2: Face Detection (4-5 Days)

### Day 1-2: Setup TensorFlow & Face Detector

#### Step 1: Install Dependencies
```bash
npm install @tensorflow/tfjs @tensorflow/tfjs-node @tensorflow-models/face-detection @tensorflow-models/coco-ssd
```

**Note**: This will take a while, TensorFlow is large. ☕

#### Step 2: Create Face Detector Service
Create file: `src/services/face-detector.service.ts`

```typescript
import * as tf from '@tensorflow/tfjs-node';
import * as faceDetection from '@tensorflow-models/face-detection';
import * as coco from '@tensorflow-models/coco-ssd';
import { log } from '../utils/logger';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';

export interface DetectedFace {
  x: number;        // center X in frame (0-1)
  y: number;        // center Y in frame (0-1)
  width: number;    // width relative to frame
  height: number;   // height relative to frame
  confidence: number; // 0-1 confidence score
}

export interface FaceDetection {
  timestamp: number;              // seconds
  faces: DetectedFace[];
  primarySubject?: DetectedFace;  // main face
}

export interface FramingInstruction {
  startTime: number;        // seconds
  endTime: number;
  cropBox: {
    x: number;              // center X in original frame
    y: number;              // center Y
    width: number;          // crop width (pixels)
    height: number;         // crop height (pixels)
  };
  transition: 'cut' | 'pan' | 'zoom';
  duration: number;         // transition duration (seconds)
}

export class FaceDetectorService {
  private static model: any;
  private static cocoModel: any;

  /**
   * Initialize face detection model (lazy load)
   */
  static async initModel() {
    if (this.model) return;
    
    log.info('[FaceDetector] Loading face detection model...');
    
    try {
      // Load BlazeFace model (fast, good for real-time)
      const detectorConfig = {
        maxFaces: 2,
        scoreThreshold: 0.5
      };
      
      this.model = await faceDetection.createDetector(
        faceDetection.SupportedModels.BlazeFaceBack,
        detectorConfig
      );
      
      log.info('[FaceDetector] Face detection model loaded');
    } catch (err) {
      log.error({ err }, '[FaceDetector] Failed to load model');
      throw err;
    }
  }

  /**
   * Detect faces in video
   * Sample every 0.5 seconds (2 fps) to save time
   */
  static async detectFaces(videoPath: string): Promise<FaceDetection[]> {
    await this.initModel();
    
    log.info({ videoPath }, '[FaceDetector] Detecting faces in video');
    const startTime = Date.now();

    // Step 1: Extract frames at 2 fps
    const framesDir = path.join('/tmp', `frames_${Date.now()}`);
    fs.mkdirSync(framesDir, { recursive: true });

    try {
      const execAsync = promisify(exec);
      
      // Extract frames
      await execAsync(`
        ffmpeg -i "${videoPath}" \
          -vf "fps=2" \
          -q:v 2 \
          "${path.join(framesDir, 'frame_%06d.jpg')}"
      `);

      // Step 2: Get video duration for timestamp calculation
      const { stdout: durationOutput } = await execAsync(`
        ffprobe -v error -show_entries format=duration \
          -of default=noprint_wrappers=1:nokey=1:noquote=1 \
          "${videoPath}"
      `);
      const duration = parseFloat(durationOutput.trim());

      // Step 3: Detect faces in each frame
      const frames = fs.readdirSync(framesDir)
        .filter(f => f.endsWith('.jpg'))
        .sort();

      const detections: FaceDetection[] = [];

      for (let i = 0; i < frames.length; i++) {
        const framePath = path.join(framesDir, frames[i]);
        const timestamp = (i * 0.5); // 0.5 second intervals
        
        if (timestamp > duration) break;

        try {
          const detection = await this.detectFacesInImage(framePath, timestamp);
          detections.push(detection);
        } catch (err) {
          log.warn({ frame: frames[i] }, '[FaceDetector] Detection failed for frame');
        }
      }

      const elapsed = Date.now() - startTime;
      log.info({ 
        detections: detections.length, 
        elapsed: `${elapsed}ms` 
      }, '[FaceDetector] Face detection complete');

      // Cleanup
      fs.rmSync(framesDir, { recursive: true });

      return detections;
    } catch (err) {
      // Cleanup on error
      if (fs.existsSync(framesDir)) {
        fs.rmSync(framesDir, { recursive: true });
      }
      
      log.error({ err }, '[FaceDetector] Face detection failed');
      throw err;
    }
  }

  /**
   * Detect faces in a single image
   */
  private static async detectFacesInImage(
    imagePath: string,
    timestamp: number
  ): Promise<FaceDetection> {
    try {
      // Load image
      const imageBuffer = fs.readFileSync(imagePath);
      const imageTensor = tf.node.decodeImage(imageBuffer, 3);
      
      // Detect faces
      const faces = await this.model.estimateFaces([imageTensor], false);
      
      // Convert to normalized coordinates (0-1)
      const detectedFaces: DetectedFace[] = faces
        .filter((face: any) => face.score >= 0.5)
        .map((face: any) => {
          const box = face.box;
          return {
            x: (box.xMin + box.xMax) / 2 / imageTensor.shape[1],   // center X
            y: (box.yMin + box.yMax) / 2 / imageTensor.shape[0],   // center Y
            width: (box.xMax - box.xMin) / imageTensor.shape[1],
            height: (box.yMax - box.yMin) / imageTensor.shape[0],
            confidence: face.score
          };
        });

      // Find primary subject (most confident face)
      let primarySubject: DetectedFace | undefined;
      if (detectedFaces.length > 0) {
        primarySubject = detectedFaces.reduce((best, face) =>
          face.confidence > best.confidence ? face : best
        );
      }

      imageTensor.dispose();

      return {
        timestamp,
        faces: detectedFaces,
        primarySubject
      };
    } catch (err) {
      log.error({ err, imagePath }, '[FaceDetector] Image detection failed');
      throw err;
    }
  }

  /**
   * Generate portrait framing instructions from face detections
   * Create smooth panning between detected faces
   */
  static generateFraming(detections: FaceDetection[]): FramingInstruction[] {
    if (detections.length === 0) {
      log.warn('[FaceDetector] No faces detected, using default centering');
      return this.generateDefaultFraming();
    }

    log.info({ detections: detections.length }, '[FaceDetector] Generating framing instructions');

    const instructions: FramingInstruction[] = [];
    const portraitWidth = 1080;
    const portraitHeight = 1920;

    // For each detection, create a framing instruction with smooth transitions
    for (let i = 0; i < detections.length; i++) {
      const detection = detections[i];
      
      if (!detection.primarySubject) {
        continue;
      }

      const subject = detection.primarySubject;
      
      // Calculate crop box centered on face
      // Original frame is 16:9, crop to 9:16 centered on face
      const originalWidth = portraitWidth * 16 / 9; // ~1920
      const originalHeight = portraitHeight; // 1920
      
      const cropX = Math.max(
        0,
        Math.min(
          originalWidth - portraitWidth,
          subject.x * originalWidth - portraitWidth / 2
        )
      );

      const cropY = Math.max(
        0,
        Math.min(
          originalHeight - portraitHeight,
          subject.y * originalHeight - portraitHeight / 2
        )
      );

      // Determine transition from previous frame
      const transition = i === 0 ? 'cut' : 'pan';
      const duration = i === 0 ? 0 : 1; // 1 second pan between frames

      instructions.push({
        startTime: detection.timestamp,
        endTime: detections[i + 1]?.timestamp || detection.timestamp + 0.5,
        cropBox: {
          x: cropX,
          y: cropY,
          width: portraitWidth,
          height: portraitHeight
        },
        transition,
        duration
      });
    }

    return instructions;
  }

  /**
   * Default framing if no faces detected
   * Just center the frame
   */
  private static generateDefaultFraming(): FramingInstruction[] {
    return [{
      startTime: 0,
      endTime: Infinity,
      cropBox: {
        x: 420,  // center crop from 1920x1920 to 1080x1920
        y: 0,
        width: 1080,
        height: 1920
      },
      transition: 'cut',
      duration: 0
    }];
  }
}
```

#### Step 3: Test Face Detection
```bash
# Create test to verify faces are detected
node -e "
const { FaceDetectorService } = require('./dist/services/face-detector.service');
FaceDetectorService.detectFaces('./test_video.mp4').then(d => {
  console.log('Detected faces:', d.length);
  console.log(d.slice(0, 3));
});
"
```

---

### Day 3-4: Portrait Converter Service

#### Step 4: Create Portrait Converter
Create file: `src/services/portrait-converter.service.ts`

```typescript
import { exec } from 'child_process';
import { promisify } from 'util';
import { log } from '../utils/logger';
import { FramingInstruction } from './face-detector.service';

export class PortraitConverterService {
  /**
   * Convert video to portrait format (9:16)
   * Apply smart cropping based on face detection
   */
  static async convertToPortrait(
    videoPath: string,
    framing?: FramingInstruction[],
    outputPath?: string
  ): Promise<string> {
    outputPath = outputPath || videoPath.replace('.mp4', '_portrait.mp4');
    
    log.info({ videoPath }, '[PortraitConverter] Converting to portrait format');
    const startTime = Date.now();

    try {
      if (!framing || framing.length === 0) {
        // Simple center crop if no framing info
        await this.applySimpleCrop(videoPath, outputPath);
      } else {
        // Smart crop with face tracking
        await this.applySmartCrop(videoPath, framing, outputPath);
      }

      const elapsed = Date.now() - startTime;
      log.info({ elapsed: `${elapsed}ms` }, '[PortraitConverter] Portrait conversion complete');
      
      return outputPath;
    } catch (err) {
      log.error({ err }, '[PortraitConverter] Conversion failed');
      throw err;
    }
  }

  /**
   * Simple center crop to portrait (9:16)
   */
  private static async applySimpleCrop(
    videoPath: string,
    outputPath: string
  ): Promise<void> {
    const execAsync = promisify(exec);
    
    // Original: 1920x1080 (16:9)
    // Portrait: 1080x1920 (9:16)
    // Crop from center: x = (1920-1080)/2 = 420, y = 0
    
    const cmd = `
      ffmpeg -i "${videoPath}" \
        -vf "crop=1080:1920:420:0" \
        -c:v libx264 -preset medium -crf 23 \
        -c:a aac -b:a 128k \
        "${outputPath}"
    `;

    await execAsync(cmd);
  }

  /**
   * Smart crop with smooth panning/zooming to follow faces
   */
  private static async applySmartCrop(
    videoPath: string,
    framing: FramingInstruction[],
    outputPath: string
  ): Promise<void> {
    const execAsync = promisify(exec);
    
    // Build complex FFmpeg filter with dynamic cropping
    const filterChain = this.buildFramingFilter(framing);
    
    const cmd = `
      ffmpeg -i "${videoPath}" \
        -vf "${filterChain}" \
        -c:v libx264 -preset medium -crf 23 \
        -c:a aac -b:a 128k \
        "${outputPath}"
    `;

    log.debug({ cmd }, '[PortraitConverter] Running FFmpeg command');
    await execAsync(cmd);
  }

  /**
   * Build FFmpeg filter string for dynamic cropping
   * Creates smooth transitions between crop positions
   */
  private static buildFramingFilter(framing: FramingInstruction[]): string {
    if (framing.length === 0) {
      return 'crop=1080:1920:420:0';
    }

    // Complex filter: apply different crops for different time ranges
    const cropFilters = framing.map((f, i) => {
      const cropSpec = `crop=1080:1920:${Math.round(f.cropBox.x)}:${Math.round(f.cropBox.y)}`;
      
      if (f.transition === 'cut') {
        // Immediate transition
        return cropSpec;
      } else if (f.transition === 'pan') {
        // Smooth pan transition using setpts
        // Interpolate between crop positions
        return `${cropSpec},select='between(t\\,${f.startTime}\\,${f.endTime})':misc_opts=duration_reset=1`;
      }
      
      return cropSpec;
    }).join(',');

    return cropFilters;
  }
}
```

---

### Day 5: Full Integration Test

#### Step 5: Update Orchestrator
File: `src/services/orchestrator.service.ts`

```typescript
// Add portrait conversion step
const portraitVideo = await PortraitConverterService.convertToPortrait(
  renderedVideo,
  framingInstructions
);
```

#### Step 6: Test Complete Pipeline
```bash
npm run dev "https://www.youtube.com/watch?v=SAMPLE_INTERVIEW_VIDEO"

# Expected output in portrait format with faces centered
```

---

## 🎯 Quick Implementation Checklist

### Audio Analysis
- [ ] Create `audio-analyzer.service.ts`
- [ ] Implement `detectPeaks()`
- [ ] Implement `detectSilence()`
- [ ] Add to orchestrator (parallel with face detection)
- [ ] Test with real audio

### Face Detection
- [ ] Install TensorFlow deps
- [ ] Create `face-detector.service.ts`
- [ ] Implement `detectFaces()` with frame sampling
- [ ] Implement `generateFraming()`
- [ ] Test face tracking accuracy

### Portrait Conversion
- [ ] Create `portrait-converter.service.ts`
- [ ] Implement simple center crop
- [ ] Implement smart crop with face tracking
- [ ] Build FFmpeg filter chains
- [ ] Test portrait output quality

### Integration
- [ ] Update orchestrator with all steps
- [ ] Test full pipeline end-to-end
- [ ] Performance optimization
- [ ] Error handling & fallbacks

---

## 💡 Tips & Tricks

### TensorFlow on Windows
If you get errors about TensorFlow native module:
```bash
# Reinstall with Python support
npm uninstall @tensorflow/tfjs-node
npm install --build-from-source @tensorflow/tfjs-node
```

### FFmpeg Filter Testing
Test FFmpeg filters independently:
```bash
# Test portrait crop only (no re-encoding)
ffmpeg -i input.mp4 -vf "crop=1080:1920:420:0" -c copy output_portrait.mp4

# Test with re-encoding (slower but safer)
ffmpeg -i input.mp4 -vf "crop=1080:1920:420:0" -c:v libx264 output.mp4
```

### Memory Management
For long videos (>30 min):
- Process in chunks (5 min each)
- Release TensorFlow tensors after each iteration
- Cleanup temp files immediately

---

## 📊 Progress Tracking

```
WEEK 1: Audio Analysis ████░░░░░░ 40%
- Setup (Done)
- Detection (In Progress)
- Integration (Pending)

WEEK 2: Face Detection & Portrait ░░░░░░░░░░ 0%
- TensorFlow setup (Pending)
- Face detection (Pending)
- Portrait conversion (Pending)

WEEK 3: Final Integration & Polish ░░░░░░░░░░ 0%
- Full pipeline test (Pending)
- Performance optimization (Pending)
- Documentation (Pending)
```

---

**Status**: Ready to implement Phase 1 (Audio Analysis)  
**Expected Completion**: 2 weeks of focused development  
**Quality Target**: Production-ready with >98% success rate

Start with **Day 1** - Create the Audio Analyzer Service! 🎬

