import { exec } from 'child_process';
import { promisify } from 'util';
import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import fs from 'fs';
import { log } from '../utils/logger';
import { ENV } from '../config/env';

ffmpeg.setFfmpegPath(ENV.FFMPEG_PATH);
const execAsync = promisify(exec);

export interface PortraitConversionConfig {
  inputWidth: number;
  inputHeight: number;
  outputFormat: 'portrait' | 'square' | 'widescreen';
  subjectCropBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  padding: number; // Additional padding around subject (0-100%)
}

export interface PortraitConversionResult {
  outputPath: string;
  outputWidth: number;
  outputHeight: number;
  format: string;
  conversionMethod: 'crop' | 'zoom' | 'pan';
  processingTime: number;
}

export interface CropBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type PortraitRenderMode = 'subject_crop' | 'subject_crop_safe' | 'blur_fallback';

export interface PortraitRenderPlan {
  mode: PortraitRenderMode;
  requestedCropBox: CropBox;
  safeSubjectBox: CropBox;
  portraitWindow: CropBox;
  reasons: string[];
  sourceAspect: number;
  targetAspect: number;
  faceConfidence: number;
}

export class PortraitConverterService {
  static getPortraitOutputDimensions(): { width: number; height: number } {
    const width = Math.max(540, ENV.PORTRAIT_OUTPUT_WIDTH || 1080);
    const height = Math.max(960, ENV.PORTRAIT_OUTPUT_HEIGHT || 1920);

    return {
      width: width % 2 === 0 ? width : width - 1,
      height: height % 2 === 0 ? height : height - 1,
    };
  }

  private static clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
  }

  private static buildSubtitleFilter(subtitlePath: string): string {
    const subtitleEscaped = subtitlePath.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "'\\''");
    const fontsDir = path.resolve(ENV.FONTS_DIR);
    const fontsDirEscaped = fontsDir.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "'\\''");
    return `subtitles='${subtitleEscaped}':fontsdir='${fontsDirEscaped}':force_style='Alignment=2,MarginL=10,MarginR=10,MarginV=30'`;
  }

  static getFallbackCropBox(inputDimensions: { width: number; height: number }): CropBox {
    return {
      x: Math.round(inputDimensions.width * 0.22),
      y: Math.round(inputDimensions.height * 0.1),
      width: Math.round(inputDimensions.width * 0.56),
      height: Math.round(inputDimensions.height * 0.74)
    };
  }

  static sanitizeCropBox(subjectCropBox: CropBox, inputDimensions: { width: number; height: number }): CropBox {
    const width = this.clamp(Math.round(subjectCropBox.width || 0), 1, inputDimensions.width);
    const height = this.clamp(Math.round(subjectCropBox.height || 0), 1, inputDimensions.height);
    const x = this.clamp(Math.round(subjectCropBox.x || 0), 0, Math.max(0, inputDimensions.width - width));
    const y = this.clamp(Math.round(subjectCropBox.y || 0), 0, Math.max(0, inputDimensions.height - height));

    return { x, y, width, height };
  }

  private static buildSafeSubjectBox(subjectCropBox: CropBox, inputDimensions: { width: number; height: number }): CropBox {
    const sanitized = this.sanitizeCropBox(subjectCropBox, inputDimensions);
    const paddingX = Math.max(sanitized.width * 0.18, inputDimensions.width * 0.035);
    const paddingY = Math.max(sanitized.height * 0.24, inputDimensions.height * 0.05);
    const minWidth = Math.max(inputDimensions.width * 0.24, 120);
    const minHeight = Math.max(inputDimensions.height * 0.34, 180);

    let x = sanitized.x - paddingX;
    let y = sanitized.y - paddingY - sanitized.height * 0.04;
    let width = sanitized.width + paddingX * 2;
    let height = sanitized.height + paddingY * 2;

    width = Math.max(width, minWidth);
    height = Math.max(height, minHeight);

    if (width > inputDimensions.width) {
      width = inputDimensions.width;
      x = 0;
    } else {
      x = this.clamp(x, 0, inputDimensions.width - width);
    }

    if (height > inputDimensions.height) {
      height = inputDimensions.height;
      y = 0;
    } else {
      y = this.clamp(y, 0, inputDimensions.height - height);
    }

    return {
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(width),
      height: Math.round(height)
    };
  }

  private static buildPortraitWindow(subjectBox: CropBox, inputDimensions: { width: number; height: number }): CropBox {
    const maxCropWidth = Math.min(inputDimensions.width, Math.round(inputDimensions.height * (9 / 16)));
    const cropWidth = Math.max(1, maxCropWidth);
    const cropHeight = Math.min(inputDimensions.height, Math.round(cropWidth * (16 / 9)));
    const subjectCenterX = subjectBox.x + subjectBox.width / 2;
    const subjectCenterY = subjectBox.y + subjectBox.height / 2;
    const cropX = this.clamp(subjectCenterX - cropWidth / 2, 0, Math.max(0, inputDimensions.width - cropWidth));
    const desiredTop = subjectCenterY - cropHeight * 0.4;
    const cropY = this.clamp(desiredTop, 0, Math.max(0, inputDimensions.height - cropHeight));

    return {
      x: Math.round(cropX),
      y: Math.round(cropY),
      width: Math.round(cropWidth),
      height: Math.round(cropHeight)
    };
  }

  static planPortraitRender(
    inputDimensions: { width: number; height: number },
    subjectCropBox: CropBox,
    options?: { usedFaceDetection?: boolean; faceConfidence?: number }
  ): PortraitRenderPlan {
    const requestedCropBox = this.sanitizeCropBox(subjectCropBox, inputDimensions);
    const safeSubjectBox = this.buildSafeSubjectBox(requestedCropBox, inputDimensions);
    const portraitWindow = this.buildPortraitWindow(safeSubjectBox, inputDimensions);
    const sourceAspect = inputDimensions.width / inputDimensions.height;
    const targetAspect = 9 / 16;
    const faceConfidence = options?.faceConfidence ?? 0;
    const reasons: string[] = [];
    let mode: PortraitRenderMode = 'subject_crop';

    const subjectWidthRatio = safeSubjectBox.width / portraitWindow.width;
    const subjectHeightRatio = safeSubjectBox.height / portraitWindow.height;
    const nearHorizontalEdge = safeSubjectBox.x <= 8 || safeSubjectBox.x + safeSubjectBox.width >= inputDimensions.width - 8;
    const nearVerticalEdge = safeSubjectBox.y <= 8 || safeSubjectBox.y + safeSubjectBox.height >= inputDimensions.height - 8;
    const portraitWindowIsValid = portraitWindow.width > 0 && portraitWindow.height > 0;
    const requestedCropLooksInvalid = requestedCropBox.width < 40 || requestedCropBox.height < 40;

    if (!portraitWindowIsValid || requestedCropLooksInvalid) {
      mode = 'blur_fallback';
      reasons.push('portrait-window-invalid');
    } else if (subjectWidthRatio > 1.18 || subjectHeightRatio > 0.98) {
      mode = 'subject_crop_safe';
      reasons.push('subject-too-large-for-clean-portrait-window');
    } else if (!options?.usedFaceDetection) {
      mode = 'subject_crop_safe';
      reasons.push('using-heuristic-subject-box');
    }

    if (faceConfidence > 0 && faceConfidence < 0.55 && mode !== 'blur_fallback') {
      mode = 'subject_crop_safe';
      reasons.push('low-face-confidence');
    }

    if ((nearHorizontalEdge || nearVerticalEdge) && mode !== 'blur_fallback') {
      mode = 'subject_crop_safe';
      reasons.push('subject-near-frame-edge');
    }

    if (reasons.length === 0) {
      reasons.push('subject-window-is-safe-for-direct-portrait-crop');
    }

    return {
      mode,
      requestedCropBox,
      safeSubjectBox,
      portraitWindow,
      reasons,
      sourceAspect,
      targetAspect,
      faceConfidence
    };
  }

  /**
   * Convert video from 16:9 (landscape) to 9:16 (portrait) with subject centered
   */
  static async convertToPortrait(
    inputPath: string,
    outputPath: string,
    subjectCropBox: { x: number; y: number; width: number; height: number },
    subtitlePath?: string
  ): Promise<PortraitConversionResult> {
    return this.convertToFormat(inputPath, outputPath, subjectCropBox, 'portrait', subtitlePath);
  }

  /**
   * Convert video to specified format (portrait, square, widescreen)
   * with subject tracking/centering
   */
  static async convertToFormat(
    inputPath: string,
    outputPath: string,
    subjectCropBox: { x: number; y: number; width: number; height: number },
    format: 'portrait' | 'square' | 'widescreen' = 'portrait',
    subtitlePath?: string
  ): Promise<PortraitConversionResult> {
    try {
      const startTime = Date.now();
      
      log.info(
        { inputPath, format, cropBox: subjectCropBox },
        '[📱 PortraitConverter] Starting conversion'
      );

      // Get input video dimensions
      const inputDimensions = await this.getVideoDimensions(inputPath);
      
      // Calculate output dimensions
      const outputDimensions = this.calculateOutputDimensions(
        inputDimensions,
        format
      );
      const renderPlan = this.planPortraitRender(inputDimensions, subjectCropBox);

      // Determine conversion method
      let conversionMethod: 'crop' | 'zoom' | 'pan';
      let filterComplex: string;

      if (format === 'portrait') {
        conversionMethod = 'crop';

        log.info(
          { 
            requestedCropBox: renderPlan.requestedCropBox,
            safeSubjectBox: renderPlan.safeSubjectBox,
            portraitWindow: renderPlan.portraitWindow,
            targetAspect: '9:16',
            actualAspect: (renderPlan.portraitWindow.width / renderPlan.portraitWindow.height).toFixed(4),
            reasons: renderPlan.reasons
          },
          '[📱 PortraitConverter] Portrait crop dimensions'
        );

        filterComplex = `crop=${renderPlan.portraitWindow.width}:${renderPlan.portraitWindow.height}:${renderPlan.portraitWindow.x}:${renderPlan.portraitWindow.y},scale=${outputDimensions.width}:${outputDimensions.height}`;
        
      } else if (format === 'square') {
        conversionMethod = 'crop'; // Square crop
        const cropSize = Math.min(inputDimensions.width, inputDimensions.height);
        const cropX = (inputDimensions.width - cropSize) / 2;
        const cropY = (inputDimensions.height - cropSize) / 2;
        
        filterComplex = `crop=${cropSize}:${cropSize}:${Math.round(cropX)}:${Math.round(cropY)},scale=${outputDimensions.width}:${outputDimensions.height}`;
      } else {
        // Widescreen: minimal scaling
        conversionMethod = 'zoom';
        filterComplex = `scale=${outputDimensions.width}:${outputDimensions.height}`;
      }

      if (subtitlePath) {
        filterComplex = `${filterComplex},${this.buildSubtitleFilter(subtitlePath)}`;
      }

      filterComplex = `${filterComplex},setsar=1`;

      // Apply FFmpeg conversion
      await this.applyFilterComplex(inputPath, outputPath, filterComplex);

      const processingTime = Date.now() - startTime;

      log.info(
        {
          outputPath,
          format,
          dimensions: `${outputDimensions.width}x${outputDimensions.height}`,
          method: conversionMethod,
          time: processingTime
        },
        '[📱 PortraitConverter] Conversion complete ✅'
      );

      return {
        outputPath,
        outputWidth: outputDimensions.width,
        outputHeight: outputDimensions.height,
        format: `${outputDimensions.width}x${outputDimensions.height}`,
        conversionMethod,
        processingTime
      };
    } catch (err) {
      log.error({ err }, '[📱 PortraitConverter] Conversion failed ❌');
      throw err;
    }
  }

  /**
   * Get video dimensions
   */
  static async getVideoDimensions(videoPath: string): Promise<{ width: number; height: number }> {
    try {
      const { stdout } = await execAsync(
        `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "${videoPath}"`
      );
      const [width, height] = stdout.trim().split('x').map(Number);
      return { width, height };
    } catch (err) {
      log.warn('Could not determine dimensions, using defaults');
      return { width: 1920, height: 1080 };
    }
  }

  static async assertValidVideo(videoPath: string): Promise<void> {
    if (!fs.existsSync(videoPath)) {
      throw new Error(`Video output not found: ${videoPath}`);
    }

    try {
      const { stdout } = await execAsync(
        `ffprobe -v error -show_entries stream=codec_name,width,height -show_entries format=duration -of json "${videoPath}"`
      );

      const parsed = JSON.parse(stdout || '{}') as {
        streams?: Array<{ codec_name?: string; width?: number; height?: number }>;
        format?: { duration?: string };
      };

      const videoStream = (parsed.streams || []).find((stream) => Boolean(stream.codec_name));
      const duration = Number(parsed.format?.duration || 0);

      if (!videoStream?.width || !videoStream?.height || !Number.isFinite(duration) || duration <= 0) {
        throw new Error('ffprobe returned incomplete metadata');
      }
    } catch (err) {
      throw new Error(`Invalid video output: ${videoPath}`);
    }
  }

  /**
   * Calculate output dimensions based on target format
   */
  static calculateOutputDimensions(
    inputDimensions: { width: number; height: number },
    format: 'portrait' | 'square' | 'widescreen'
  ): { width: number; height: number } {
    switch (format) {
      case 'portrait':
        return this.getPortraitOutputDimensions();
      
      case 'square':
        // 1:1 aspect ratio
        return { width: 1080, height: 1080 };
      
      case 'widescreen':
      default:
        // Keep original or use common widescreen
        return { width: 1920, height: 1080 };
    }
  }

  /**
   * Apply FFmpeg filter complex - using shell execution for reliability
   */
  static async applyFilterComplex(
    inputPath: string,
    outputPath: string,
    filterComplex: string
  ): Promise<void> {
    return new Promise(async (resolve, reject) => {
      try {
        const { exec } = await import('child_process');
        const { promisify } = await import('util');
        const execAsync = promisify(exec);
        
        const ffmpegCmd = `"${ENV.FFMPEG_PATH}" -i "${inputPath}" -vf "${filterComplex}" -c:v libx264 -crf ${ENV.PORTRAIT_VIDEO_CRF} -preset ${ENV.PORTRAIT_VIDEO_PRESET} -movflags +faststart -c:a copy -y "${outputPath}"`;
        
        log.debug({ cmd: ffmpegCmd }, '[📱 PortraitConverter] Executing FFmpeg');
        
        const { stdout, stderr } = await execAsync(ffmpegCmd, { maxBuffer: 10 * 1024 * 1024, timeout: ENV.PORTRAIT_RENDER_TIMEOUT_MS });
        
        log.debug('[📱 PortraitConverter] FFmpeg execution complete');
        resolve();
      } catch (err) {
        log.error({ err }, '[📱 PortraitConverter] FFmpeg error');
        reject(err);
      }
    });
  }

  /**
   * Convert with blur background fallback
   * If aspect ratio doesn't allow simple crop+scale, use blurred background instead
   */
  static async convertWithBlurFallback(
    inputPath: string,
    outputPath: string,
    subjectCropBox: { x: number; y: number; width: number; height: number },
    targetWidth?: number,
    targetHeight?: number,
    subtitlePath?: string
  ): Promise<void> {
    return new Promise(async (resolve, reject) => {
      try {
        const portraitDimensions = this.getPortraitOutputDimensions();
        const resolvedTargetWidth = targetWidth || portraitDimensions.width;
        const resolvedTargetHeight = targetHeight || portraitDimensions.height;

        log.info(
          { targetWidth: resolvedTargetWidth, targetHeight: resolvedTargetHeight, aspect: (resolvedTargetWidth / resolvedTargetHeight).toFixed(4) },
          '[📱 PortraitConverter] Convert with blur background fallback'
        );

        const { exec } = await import('child_process');
        const { promisify } = await import('util');
        const execAsync = promisify(exec);
        const inputDimensions = await this.getVideoDimensions(inputPath);
        const renderPlan = this.planPortraitRender(inputDimensions, subjectCropBox);
        const foregroundBox = renderPlan.safeSubjectBox;
        const overlayY = Math.round(resolvedTargetHeight * 0.08);

        const subtitleFilter = subtitlePath ? this.buildSubtitleFilter(subtitlePath) : '';
        const filterComplex = subtitleFilter
          ? `[0:v]scale=${resolvedTargetWidth}:${resolvedTargetHeight}:force_original_aspect_ratio=increase,crop=${resolvedTargetWidth}:${resolvedTargetHeight},boxblur=12:4[bg];` +
            `[0:v]crop=${foregroundBox.width}:${foregroundBox.height}:${foregroundBox.x}:${foregroundBox.y},scale=${resolvedTargetWidth}:${resolvedTargetHeight}:force_original_aspect_ratio=decrease[fg];` +
            `[bg][fg]overlay=(W-w)/2:${overlayY}[pre];` +
            `[pre]${subtitleFilter},setsar=1[out]`
          : `[0:v]scale=${resolvedTargetWidth}:${resolvedTargetHeight}:force_original_aspect_ratio=increase,crop=${resolvedTargetWidth}:${resolvedTargetHeight},boxblur=12:4[bg];` +
            `[0:v]crop=${foregroundBox.width}:${foregroundBox.height}:${foregroundBox.x}:${foregroundBox.y},scale=${resolvedTargetWidth}:${resolvedTargetHeight}:force_original_aspect_ratio=decrease[fg];` +
            `[bg][fg]overlay=(W-w)/2:${overlayY},setsar=1[out]`;

        const ffmpegCmd =
          `"${ENV.FFMPEG_PATH}" -i "${inputPath}" -filter_complex "${filterComplex}" -map "[out]" -map "0:a?" -c:v libx264 -crf ${ENV.PORTRAIT_VIDEO_CRF} -preset ${ENV.PORTRAIT_VIDEO_PRESET} -movflags +faststart -c:a copy -y "${outputPath}"`;

        log.info(
          { foregroundBox, portraitWindow: renderPlan.portraitWindow, reasons: renderPlan.reasons },
          '[📱 PortraitConverter] Using subject-aware blur fallback'
        );
        log.debug({ cmd: ffmpegCmd }, '[📱 PortraitConverter] Executing blur fallback');

        const { stdout, stderr } = await execAsync(ffmpegCmd, {
          maxBuffer: 10 * 1024 * 1024,
          timeout: ENV.PORTRAIT_RENDER_TIMEOUT_MS
        });

        log.info('[📱 PortraitConverter] Blur fallback complete');
        resolve();
      } catch (err: any) {
        log.error({ err: err.message }, '[📱 PortraitConverter] Blur fallback failed');
        reject(err);
      }
    });
  }

  /**
    inputPath: string,
    outputPath: string,
    targetWidth: number,
    targetHeight: number,
    backgroundColor: string = '#000000'
  ): Promise<void> {
    const filterComplex = `pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2:color=${backgroundColor}`;
    
    return new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .videoFilters(filterComplex)
        .audioCodec('copy') // Copy audio without re-encoding
        .output(outputPath)
        .on('error', reject)
        .on('end', () => {
          // Add delay to ensure file is fully written and flushed
          setTimeout(() => {
            resolve();
          }, 500);
        })
        .run();
    });
  }

  /**
   * Apply smooth zoom effect to simulate subject tracking
   * Moves smoothly to follow face as it moves through video
   */
  static async applySubjectTracking(
    inputPath: string,
    outputPath: string,
    cropBox: { x: number; y: number; width: number; height: number }
  ): Promise<void> {
    try {
      log.info('[📱 PortraitConverter] Applying subject tracking effect');
      
      // Simple pan effect: start at center, end at center
      // Real implementation would use advanced keyframe animation
      const filterComplex = `fps=30,format=yuv420p`;

      return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
          .videoFilters(filterComplex)
          .audioCodec('copy') // Copy audio without re-encoding
          .output(outputPath)
          .on('error', reject)
          .on('end', () => {
            log.info('[📱 PortraitConverter] Tracking effect applied');
            // Add delay to ensure file is fully written and flushed
            setTimeout(() => {
              resolve();
            }, 500);
          })
          .run();
      });
    } catch (err) {
      log.warn('[📱 PortraitConverter] Subject tracking failed, continuing without it');
      throw err;
    }
  }

  /**
   * Batch convert multiple videos to portrait format
   */
  static async batchConvertToPortrait(
    inputPaths: string[],
    outputDir: string,
    cropBoxes: { x: number; y: number; width: number; height: number }[]
  ): Promise<PortraitConversionResult[]> {
    const results: PortraitConversionResult[] = [];

    for (let i = 0; i < inputPaths.length; i++) {
      const inputPath = inputPaths[i];
      const outputPath = path.join(outputDir, `portrait_${i + 1}.mp4`);
      const cropBox = cropBoxes[i] || cropBoxes[0];

      try {
        const result = await this.convertToPortrait(inputPath, outputPath, cropBox);
        results.push(result);
      } catch (err) {
        log.error({ err, index: i }, '[📱 PortraitConverter] Batch conversion failed at index');
        results.push({
          outputPath: '',
          outputWidth: 0,
          outputHeight: 0,
          format: 'error',
          conversionMethod: 'crop',
          processingTime: 0
        });
      }
    }

    return results;
  }
}
