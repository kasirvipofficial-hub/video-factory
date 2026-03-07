import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import { log } from '../utils/logger';
import { ENV } from '../config/env';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

export interface CropBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FaceTrajectory {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  avgX: number;
  avgY: number;
}

export interface FaceDetection {
  x: number;           // Left edge (pixels)
  y: number;           // Top edge (pixels)
  width: number;       // Face width (pixels)
  height: number;      // Face height (pixels)
  confidence: number;  // 0-1 confidence score
  frame: number;       // Video frame number
  timestamp: number;   // Seconds in video
}

export interface FaceAnalysis {
  totalFrames: number;
  framesWithFaces: number;
  faceCount: number;
  facDetections: FaceDetection[];
  recommendedCropBox: CropBox;
  faceTrajectory: FaceTrajectory;
  backend?: string;
  model?: string;
  sampleIntervalSeconds?: number;
}

interface ExternalDetectorResult {
  backend?: string;
  model?: string;
  sampleIntervalSeconds?: number;
  totalFrames?: number;
  framesWithFaces?: number;
  faceCount?: number;
  facDetections?: FaceDetection[];
  detections?: FaceDetection[];
  recommendedCropBox?: CropBox;
  faceTrajectory?: FaceTrajectory;
}

export class FaceDetectorService {
  /**
   * Analyze video for face detection
   * Uses FFmpeg-based scene detection as fallback
   * Full implementation uses TensorFlow models
   */
  static async analyzeVideoForFaces(videoPath: string): Promise<FaceAnalysis> {
    try {
      log.info({ videoPath }, '[👁️ FaceDetector] Starting face detection');
      const startTime = Date.now();

      const videoDimensions = await this.getVideoDimensions(videoPath);
      let analysis: FaceAnalysis;

      if (ENV.FACE_DETECTOR_BACKEND === 'yolov8n') {
        try {
          analysis = await this.analyzeVideoWithYolo(videoPath, videoDimensions);
        } catch (err) {
          log.warn(
            { err, backend: ENV.FACE_DETECTOR_BACKEND },
            '[👁️ FaceDetector] YOLO detector unavailable, falling back to heuristic detector'
          );
          analysis = await this.analyzeVideoWithHeuristic(videoPath, videoDimensions);
        }
      } else {
        analysis = await this.analyzeVideoWithHeuristic(videoPath, videoDimensions);
      }

      const duration = Date.now() - startTime;

      log.info({
        duration: `${duration}ms`,
        backend: analysis.backend,
        facesFound: analysis.faceCount,
        framesWithFaces: analysis.framesWithFaces
      }, '[👁️ FaceDetector] Analysis complete ✅');

      return analysis;
    } catch (err) {
      log.error({ err }, '[👁️ FaceDetector] Analysis failed ❌');
      throw err;
    }
  }

  private static async analyzeVideoWithHeuristic(
    videoPath: string,
    videoDimensions: { width: number; height: number }
  ): Promise<FaceAnalysis> {
    const frames = await this.extractKeyFrames(videoPath, ENV.FACE_DETECTOR_SAMPLE_INTERVAL_SECONDS);
    log.debug({ frameCount: frames.length }, '[👁️ FaceDetector] Frames extracted');

    try {
      const detections = await this.detectFacesInFrames(frames, videoDimensions);
      const cropBox = this.calculateRecommendedCropBox(detections, videoDimensions);
      const trajectory = this.getTrajectory(detections);

      return {
        totalFrames: frames.length,
        framesWithFaces: detections.filter(d => d.confidence > 0.5).length,
        faceCount: detections.length,
        facDetections: detections,
        recommendedCropBox: cropBox,
        faceTrajectory: trajectory,
        backend: 'heuristic',
        model: 'center-weighted-heuristic',
        sampleIntervalSeconds: ENV.FACE_DETECTOR_SAMPLE_INTERVAL_SECONDS
      };
    } finally {
      await this.cleanup(videoPath);
    }
  }

  private static async analyzeVideoWithYolo(
    videoPath: string,
    videoDimensions: { width: number; height: number }
  ): Promise<FaceAnalysis> {
    const scriptPath = path.resolve(ENV.YOLO_SCRIPT_PATH);
    if (!fs.existsSync(scriptPath)) {
      throw new Error(`YOLO detector script not found: ${scriptPath}`);
    }

    const outputPath = path.join(path.dirname(videoPath), `yolo_person_detection_${Date.now()}.json`);
    const args = [
      scriptPath,
      '--video',
      path.resolve(videoPath),
      '--output',
      outputPath,
      '--model',
      ENV.YOLO_MODEL_PATH,
      '--sample-interval',
      String(ENV.FACE_DETECTOR_SAMPLE_INTERVAL_SECONDS),
      '--confidence',
      String(ENV.YOLO_CONFIDENCE_THRESHOLD),
      '--max-frames',
      String(ENV.YOLO_MAX_FRAMES),
      '--imgsz',
      String(ENV.YOLO_IMAGE_SIZE)
    ];

    if (ENV.YOLO_DEVICE.trim()) {
      args.push('--device', ENV.YOLO_DEVICE);
    }

    log.info(
      {
        backend: 'yolov8n',
        python: ENV.YOLO_PYTHON_PATH,
        scriptPath,
        sampleIntervalSeconds: ENV.FACE_DETECTOR_SAMPLE_INTERVAL_SECONDS,
        maxFrames: ENV.YOLO_MAX_FRAMES
      },
      '[👁️ FaceDetector] Running YOLOv8n person detector'
    );

    try {
      const { stderr } = await execFileAsync(ENV.YOLO_PYTHON_PATH, args, {
        windowsHide: true,
        timeout: ENV.YOLO_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024
      });

      if (stderr) {
        log.debug({ stderr }, '[👁️ FaceDetector] YOLO detector stderr');
      }

      if (!fs.existsSync(outputPath)) {
        throw new Error(`YOLO detector did not produce output: ${outputPath}`);
      }

      const parsed = JSON.parse(fs.readFileSync(outputPath, 'utf8')) as ExternalDetectorResult;
      return this.normalizeExternalAnalysis(parsed, videoDimensions);
    } finally {
      try {
        if (fs.existsSync(outputPath)) {
          fs.unlinkSync(outputPath);
        }
      } catch (err) {
        log.debug({ err, outputPath }, '[👁️ FaceDetector] Could not remove YOLO output file');
      }
    }
  }

  private static normalizeExternalAnalysis(
    payload: ExternalDetectorResult,
    videoDimensions: { width: number; height: number }
  ): FaceAnalysis {
    const sourceDetections = payload.facDetections || payload.detections || [];
    const detections = sourceDetections
      .map((detection, index) => ({
        x: Math.round(Math.max(0, detection.x || 0)),
        y: Math.round(Math.max(0, detection.y || 0)),
        width: Math.round(Math.max(1, detection.width || 1)),
        height: Math.round(Math.max(1, detection.height || 1)),
        confidence: Number.isFinite(detection.confidence) ? detection.confidence : 0,
        frame: detection.frame || index + 1,
        timestamp: Number.isFinite(detection.timestamp) ? detection.timestamp : index * ENV.FACE_DETECTOR_SAMPLE_INTERVAL_SECONDS
      }))
      .filter((detection) => detection.width > 0 && detection.height > 0)
      .sort((left, right) => left.timestamp - right.timestamp);

    if (detections.length === 0) {
      throw new Error('YOLO detector returned zero person detections');
    }

    const recommendedCropBox = payload.recommendedCropBox
      ? this.sanitizeCropBox(payload.recommendedCropBox, videoDimensions)
      : this.calculateRecommendedCropBox(detections, videoDimensions);
    const faceTrajectory = payload.faceTrajectory || this.getTrajectory(detections);

    return {
      totalFrames: payload.totalFrames || detections.length,
      framesWithFaces: payload.framesWithFaces || detections.filter((detection) => detection.confidence > 0.5).length,
      faceCount: payload.faceCount || detections.length,
      facDetections: detections,
      recommendedCropBox,
      faceTrajectory,
      backend: payload.backend || 'yolov8n',
      model: payload.model || path.basename(ENV.YOLO_MODEL_PATH),
      sampleIntervalSeconds: payload.sampleIntervalSeconds || ENV.FACE_DETECTOR_SAMPLE_INTERVAL_SECONDS
    };
  }

  private static sanitizeCropBox(
    cropBox: CropBox,
    videoDimensions: { width: number; height: number }
  ): CropBox {
    const width = Math.max(1, Math.min(videoDimensions.width, Math.round(cropBox.width || 0)));
    const height = Math.max(1, Math.min(videoDimensions.height, Math.round(cropBox.height || 0)));
    const x = Math.max(0, Math.min(videoDimensions.width - width, Math.round(cropBox.x || 0)));
    const y = Math.max(0, Math.min(videoDimensions.height - height, Math.round(cropBox.y || 0)));

    return { x, y, width, height };
  }

  /**
   * Get video dimensions (width x height)
   */
  static async getVideoDimensions(videoPath: string): Promise<{ width: number; height: number }> {
    try {
      const { stdout } = await execAsync(
        `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "${videoPath}"`
      );
      const [width, height] = stdout.trim().split('x').map(Number);
      return { width, height };
    } catch (err) {
      log.warn('Could not determine video dimensions, using defaults');
      return { width: 1920, height: 1080 };
    }
  }

  /**
   * Extract key frames from video (sampling every 5 seconds)
   */
  static async extractKeyFrames(videoPath: string, interval: number = 5): Promise<string[]> {
    try {
      const frameDir = path.join(path.dirname(videoPath), 'frames');
      
      if (!fs.existsSync(frameDir)) {
        fs.mkdirSync(frameDir, { recursive: true });
      }

      // Extract frames every N seconds
      await execAsync(
        `ffmpeg -i "${videoPath}" -vf fps=1/${interval} "${frameDir}\\frame_%04d.jpg" -y 2>&1`
      );

      // List extracted frames
      const frames = fs.readdirSync(frameDir)
        .filter(f => f.endsWith('.jpg'))
        .map(f => path.join(frameDir, f))
        .sort();

      log.debug({ count: frames.length }, '[👁️ FaceDetector] Frames extracted');
      return frames;
    } catch (err) {
      log.warn({ err }, '[👁️ FaceDetector] Frame extraction failed');
      return [];
    }
  }

  /**
   * Detect faces in extracted frames
   * Simplified implementation: Creates fake detections for demo
   * Real implementation would use TensorFlow face-api or similar
   */
  static async detectFacesInFrames(
    framePaths: string[],
    videoDimensions: { width: number; height: number }
  ): Promise<FaceDetection[]> {
    const detections: FaceDetection[] = [];

    // Deterministic fallback detector (no random dropouts):
    // keeps framing stable for portrait conversion even without ML runtime.
    framePaths.forEach((_framePath, index) => {
      const frameNum = index + 1;
      const timestamp = index * 5; // Assuming 5-second intervals

      const faceWidth = videoDimensions.width * 0.36;
      const faceHeight = videoDimensions.height * 0.48;

      // Add slight deterministic horizontal drift to mimic natural movement.
      const drift = Math.sin(index / 3) * (videoDimensions.width * 0.03);
      const faceX = (videoDimensions.width - faceWidth) / 2 + drift;
      const faceY = videoDimensions.height * 0.28;

      detections.push({
        x: Math.round(Math.max(0, faceX)),
        y: Math.round(Math.max(0, faceY)),
        width: Math.round(faceWidth),
        height: Math.round(faceHeight),
        confidence: 0.9,
        frame: frameNum,
        timestamp
      });
    });

    // If frame extraction fails entirely, still provide one safe center detection.
    if (detections.length === 0) {
      detections.push({
        x: Math.round(videoDimensions.width * 0.32),
        y: Math.round(videoDimensions.height * 0.26),
        width: Math.round(videoDimensions.width * 0.36),
        height: Math.round(videoDimensions.height * 0.48),
        confidence: 0.8,
        frame: 1,
        timestamp: 0
      });
    }

    log.debug(
      { count: detections.length, frames: framePaths.length },
      '[👁️ FaceDetector] Faces detected'
    );

    return detections;
  }

  /**
   * Calculate recommended crop box to include all faces with padding
   */
  static calculateRecommendedCropBox(
    detections: FaceDetection[],
    videoDimensions: { width: number; height: number }
  ): CropBox {
    if (detections.length === 0) {
      // Default: center crop
      return {
        x: 0,
        y: videoDimensions.height * 0.2,
        width: videoDimensions.width,
        height: videoDimensions.height * 0.6
      };
    }

    // Find bounding box containing all faces
    let minX = Math.min(...detections.map(d => d.x));
    let minY = Math.min(...detections.map(d => d.y));
    let maxX = Math.max(...detections.map(d => d.x + d.width));
    let maxY = Math.max(...detections.map(d => d.y + d.height));

    // Add 20% padding
    const paddingX = (maxX - minX) * 0.1;
    const paddingY = (maxY - minY) * 0.1;

    minX = Math.max(0, minX - paddingX);
    minY = Math.max(0, minY - paddingY);
    maxX = Math.min(videoDimensions.width, maxX + paddingX);
    maxY = Math.min(videoDimensions.height, maxY + paddingY);

    return {
      x: Math.round(minX),
      y: Math.round(minY),
      width: Math.round(maxX - minX),
      height: Math.round(maxY - minY)
    };
  }

  /**
   * Calculate face trajectory through video
   */
  static getTrajectory(detections: FaceDetection[]) {
    if (detections.length === 0) {
      return {
        minX: 0,
        maxX: 1920,
        minY: 0,
        maxY: 1080,
        avgX: 960,
        avgY: 540
      };
    }

    const xs = detections.map(d => d.x + d.width / 2);
    const ys = detections.map(d => d.y + d.height / 2);

    return {
      minX: Math.round(Math.min(...xs)),
      maxX: Math.round(Math.max(...xs)),
      minY: Math.round(Math.min(...ys)),
      maxY: Math.round(Math.max(...ys)),
      avgX: Math.round(xs.reduce((a, b) => a + b) / xs.length),
      avgY: Math.round(ys.reduce((a, b) => a + b) / ys.length)
    };
  }

  /**
   * Clean up temporary frame files
   */
  static async cleanup(videoPath: string): Promise<void> {
    try {
      const frameDir = path.join(path.dirname(videoPath), 'frames');
      if (fs.existsSync(frameDir)) {
        fs.rmSync(frameDir, { recursive: true, force: true });
        log.debug('[👁️ FaceDetector] Temporary frames cleaned up');
      }
    } catch (err) {
      log.warn({ err }, '[👁️ FaceDetector] Cleanup failed');
    }
  }
}
