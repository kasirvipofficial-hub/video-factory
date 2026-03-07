import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

function optional(key: string, fallback: string): string {
    return process.env[key] || fallback;
}

function optionalInt(key: string, fallback: string): number {
    return parseInt(optional(key, fallback), 10);
}

function optionalFloat(key: string, fallback: string): number {
    return parseFloat(optional(key, fallback));
}

export const ENV = {
    // Server
    PORT: parseInt(process.env.PORT || '8080', 10),
    NODE_ENV: optional('NODE_ENV', 'development'),
    API_BEARER_TOKEN: optional('API_BEARER_TOKEN', ''),

    // Redis / Queue
    REDIS_URL: optional('REDIS_URL', 'redis://127.0.0.1:6379'),
    REDIS_PREFIX: optional('REDIS_PREFIX', 'clipper'),
    CLIP_QUEUE_NAME: optional('CLIP_QUEUE_NAME', 'clip.jobs'),
    WEBHOOK_QUEUE_NAME: optional('WEBHOOK_QUEUE_NAME', 'clip.webhooks'),
    FALLBACK_QUEUE_NAME: optional('FALLBACK_QUEUE_NAME', 'clip.fallbacks'),
    CLIP_WORKER_CONCURRENCY: parseInt(optional('CLIP_WORKER_CONCURRENCY', '1'), 10),
    WEBHOOK_WORKER_CONCURRENCY: parseInt(optional('WEBHOOK_WORKER_CONCURRENCY', '3'), 10),

    // YouTube
    YT_DLP_PATH: optional('YT_DLP_PATH', 'yt-dlp'),
    COOKIES_FILE: optional('COOKIES_FILE', './cookies.txt'),

    // FFmpeg
    FFMPEG_PATH: optional('FFMPEG_PATH', 'ffmpeg'),
    PORTRAIT_OUTPUT_WIDTH: optionalInt('PORTRAIT_OUTPUT_WIDTH', '1080'),
    PORTRAIT_OUTPUT_HEIGHT: optionalInt('PORTRAIT_OUTPUT_HEIGHT', '1920'),
    PORTRAIT_VIDEO_PRESET: optional('PORTRAIT_VIDEO_PRESET', 'veryfast'),
    PORTRAIT_VIDEO_CRF: optionalInt('PORTRAIT_VIDEO_CRF', '20'),
    PORTRAIT_RENDER_TIMEOUT_MS: optionalInt('PORTRAIT_RENDER_TIMEOUT_MS', '600000'),

    // Face / Person Detection
    FACE_DETECTOR_BACKEND: optional('FACE_DETECTOR_BACKEND', 'heuristic'),
    FACE_DETECTOR_SAMPLE_INTERVAL_SECONDS: optionalFloat('FACE_DETECTOR_SAMPLE_INTERVAL_SECONDS', '1'),
    YOLO_PYTHON_PATH: optional('YOLO_PYTHON_PATH', 'python'),
    YOLO_SCRIPT_PATH: optional('YOLO_SCRIPT_PATH', './scripts/yolo_person_detect.py'),
    YOLO_MODEL_PATH: optional('YOLO_MODEL_PATH', 'yolov8n.pt'),
    YOLO_CONFIDENCE_THRESHOLD: optionalFloat('YOLO_CONFIDENCE_THRESHOLD', '0.35'),
    YOLO_MAX_FRAMES: optionalInt('YOLO_MAX_FRAMES', '90'),
    YOLO_TIMEOUT_MS: optionalInt('YOLO_TIMEOUT_MS', '180000'),
    YOLO_IMAGE_SIZE: optionalInt('YOLO_IMAGE_SIZE', '640'),
    YOLO_DEVICE: optional('YOLO_DEVICE', ''),

    // AI Analysis
    AI_API_BASE_URL: optional('AI_API_BASE_URL', 'https://ai.sumopod.com/v1'),
    AI_API_KEY: optional('AI_API_KEY', ''),
    AI_MODEL: optional('AI_MODEL', 'seed-2-0-mini-free'),

    // TTS
    TTS_PROVIDER: optional('TTS_PROVIDER', 'huggingface'),
    HUGGINGFACE_API_KEY: optional('HUGGINGFACE_API_KEY', ''),
    OPENAI_TTS_API_KEY: optional('OPENAI_TTS_API_KEY', ''),

    // Whisper
    WHISPER_API_URL: optional('WHISPER_API_URL', 'https://api.openai.com/v1'),
    WHISPER_API_KEY: optional('WHISPER_API_KEY', ''),
    WHISPER_TIMEOUT_MS: parseInt(optional('WHISPER_TIMEOUT_MS', '600000'), 10),
    WHISPER_MAX_FILE_MB: parseInt(optional('WHISPER_MAX_FILE_MB', '20'), 10),
    WHISPER_CHUNK_SECONDS: parseInt(optional('WHISPER_CHUNK_SECONDS', '480'), 10),
    WHISPER_AUDIO_BITRATE: optional('WHISPER_AUDIO_BITRATE', '64k'),
    WHISPER_AUDIO_SAMPLE_RATE: parseInt(optional('WHISPER_AUDIO_SAMPLE_RATE', '16000'), 10),

    // Music
    MUSIC_DIR: optional('MUSIC_DIR', './assets/music'),
    USE_BACKGROUND_MUSIC: process.env.USE_BACKGROUND_MUSIC !== 'false',

    // Fonts
    FONTS_DIR: optional('FONTS_DIR', './assets/fonts'),

    // Directories
    OUTPUT_DIR: optional('OUTPUT_DIR', './output'),
    TEMP_DIR: optional('TEMP_DIR', './temp'),
    RESULTS_DIR: optional('RESULTS_DIR', './results'),
    CLEANUP_TEMP_FILES: optional('CLEANUP_TEMP_FILES', 'true') === 'true',
    CLEANUP_RESULT_FILES: optional('CLEANUP_RESULT_FILES', 'true') === 'true',

    // Limits
    MAX_DURATION: parseInt(optional('MAX_DURATION', '180'), 10),
    MIN_OUTPUT_DURATION: parseInt(optional('MIN_OUTPUT_DURATION', '60'), 10),
    MAX_OUTPUT_DURATION: parseInt(optional('MAX_OUTPUT_DURATION', '180'), 10),
    DISCOVERY_MIN_VIDEO_SECONDS: parseInt(optional('DISCOVERY_MIN_VIDEO_SECONDS', '600'), 10),
    DISCOVERY_SELECTION_TIMEOUT_MS: parseInt(optional('DISCOVERY_SELECTION_TIMEOUT_MS', '120000'), 10),
    DISCOVERY_VISION_RERANK_ENABLED: optional('DISCOVERY_VISION_RERANK_ENABLED', 'false') === 'true',
    DISCOVERY_VISION_RERANK_TOP_N: parseInt(optional('DISCOVERY_VISION_RERANK_TOP_N', '3'), 10),
    WEBHOOK_MAX_RETRIES: parseInt(optional('WEBHOOK_MAX_RETRIES', '5'), 10),
    DEFAULT_TENANT_ID: optional('DEFAULT_TENANT_ID', 'default'),
    AI_DATA_TIMEOUT_MS: parseInt(optional('AI_DATA_TIMEOUT_MS', '300000'), 10),
    AI_DIRECTOR_TIMEOUT_MS: parseInt(optional('AI_DIRECTOR_TIMEOUT_MS', '180000'), 10),
    JOB_STALE_AFTER_MS: parseInt(optional('JOB_STALE_AFTER_MS', '900000'), 10),

    // Logging
    LOG_LEVEL: optional('LOG_LEVEL', 'info'),

    // Storage R2
    S3_ENDPOINT: optional('S3_ENDPOINT', ''),
    S3_BUCKET: optional('S3_BUCKET', ''),
    S3_ACCESS_KEY: optional('S3_ACCESS_KEY', ''),
    S3_SECRET_KEY: optional('S3_SECRET_KEY', ''),
    S3_PUBLIC_URL: optional('S3_PUBLIC_URL', ''),
    S3_REGION: optional('S3_REGION', 'auto'),
    S3_UPLOAD_PREFIX: optional('S3_UPLOAD_PREFIX', 'clipper'),
    S3_UPLOAD_TIMEOUT_MS: parseInt(optional('S3_UPLOAD_TIMEOUT_MS', '180000'), 10),
    S3_UPLOAD_MAX_RETRIES: parseInt(optional('S3_UPLOAD_MAX_RETRIES', '2'), 10),
};
