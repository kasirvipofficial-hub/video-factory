# 🎬 Clipper - Project Structure & Setup Summary

## 📂 Struktur Folder

```
clipper/
├── src/
│   ├── services/
│   │   ├── youtube.service.ts       # Download dari YouTube (yt-dlp)
│   │   ├── ai-analyzer.service.ts   # Analisis dengan LLM (highlight detection)
│   │   ├── whisper.service.ts       # Transkripsi audio (Whisper API)
│   │   ├── tts.service.ts           # Text-to-Speech (gTTS/OpenAI/HuggingFace)
│   │   ├── subtitle.service.ts      # Generate ASS/SRT subtitles
│   │   ├── ffmpeg.service.ts        # FFmpeg operations (cut, concat, color, etc)
│   │   └── orchestrator.service.ts  # Main flow orchestration
│   ├── utils/
│   │   └── logger.ts                # Logging dengan Pino
│   ├── config/
│   │   └── env.ts                   # Environment configuration
│   └── index.ts                     # CLI entry point
├── package.json                     # Dependencies
├── tsconfig.json                    # TypeScript config
├── .env                             # Environment variables (sudah ada)
├── .env.example                     # Template environment
├── README.md                        # Project documentation
└── dist/                            # Compiled JavaScript (generated)
```

## Docker Setup

1. Jalankan `chmod +x install.sh && ./install.sh`.
2. Jika `.env` belum ada, installer akan membuatnya dari `.env.example`.
3. Installer akan meminta nilai env penting yang masih placeholder, lalu generate `API_BEARER_TOKEN` otomatis.
4. Installer akan build container, start stack, dan menunggu API siap.
5. Cek `http://localhost:8080/health`.

Jika Anda ingin mode non-interaktif, siapkan `.env` lengkap lebih dulu lalu jalankan `./install.sh`.

### Cloudflared Tunnel

Jika tunnel Cloudflare sudah berjalan di host yang sama, arahkan public hostname tunnel ke `http://localhost:8080`.

Rekomendasi ini sengaja dipakai agar API tidak perlu dibuka ke internet lewat port publik VPS.

## API Input

Request body for `POST /api/v1/jobs`:

```json
{
    "youtubeUrl": "https://www.youtube.com/watch?v=VIDEO_ID",
    "mode": "auto",
    "selectionPolicy": "auto_best",
    "customization": {
        "targetPlatform": "tiktok",
        "postingTone": "tajam dan informatif",
        "targetAudience": "audiens politik Indonesia",
        "language": "id",
        "callToAction": "Setuju atau tidak?",
        "captionStyle": "ringkas",
        "hashtags": ["politik", "shorts"],
        "additionalInstructions": "Fokus pada konflik paling kuat",
        "font": {
            "family": "Oswald",
            "size": 76,
            "stylePreset": "karaoke_yellow"
        },
        "filters": ["vignette"]
    }
}
```

`font.family` dan `font.size` memengaruhi subtitle ASS/karaoke yang dirender ke video. `filters` memakai preset dari `FilterService`, misalnya `vignette`, `sepia`, `dramatic`, `warm`, `cold`, `grain`, atau `sharpen`.

## API Output

Saat job selesai, `job.result` berisi URL R2 final video dan analysis markdown, plus metadata posting yang siap dipakai.

## 🚀 Main Flow (Single Pipeline)

```
YouTube URL
    ↓ (Step 1)
📥 YouTubeService.download()
    ↓ (Step 2)
🔊 FFmpegService.extractAudio()
    ↓ (Step 3)
💬 WhisperService.transcribe() → Get full text
    ↓ (Step 4)
🧠 AIAnalyzer.analyzeHighlights() → Get segments with scores
    ↓ (Step 5)
✂️ FFmpegService.cutSegment() → For each highlight
    ↓
⛓️ FFmpegService.concat() → Join all highlights
    ↓ (Step 6)
🎤 TTSService.generateVoice() → Generate narration
    ↓
📝 SubtitleService.generateASS() → Create subtitles
    ↓
📹 FFmpegService.addSubtitles() → Add to final video
    ↓
📸 FFmpegService.generateThumbnail() → Create thumbnail
    ↓
✅ Output: R2 video URL, R2 analysis URL, posting title, caption, hashtags, duration
```

## 📋 Services Explanation

### 1. **YouTubeService**
- Download video dari YouTube menggunakan `yt-dlp`
- Extract video metadata (title, duration, ID)
- Handle cookies untuk bypass throttling

### 2. **AIAnalyzer**
- Kirim transcript ke LLM melalui proxy
- AI identify highlight moments dengan scoring (0-1)
- Return: list of segments dengan reason & score
- Fallback jika analysis gagal

### 3. **WhisperService**
- Transcribe audio ke segments dengan timestamps
- Support verbose JSON untuk accuracy
- Generate SRT dan ASS formats

### 4. **TTSService**
- Multiple providers: gTTS (free), OpenAI TTS, HuggingFace
- Auto-fallback ke gTTS jika provider lain gagal
- Generate MP3 untuk narasi

### 5. **SubtitleService**
- Generate ASS with styling (font, color, timing)
- Support multiple resolutions
- Generate SRT untuk compatibility

### 6. **FFmpegService**
- Core video processing:
  - **extractAudio**: MP3 dari video
  - **cutSegment**: Extract bagian dari timestamp
  - **concat**: Join multiple segments
  - **scaleAndCrop**: Resize ke target resolution
  - **applyColorGrade**: Color grading + LUT
  - **addSubtitles**: Overlay ASS subtitles
  - **mixAudio**: Mix video audio + background music
  - **generateThumbnail**: JPG dari video

### 7. **Orchestrator**
- Main controller yang mengatur flow
- Manage temp directories
- Handle error & logging
- Return final result dengan metadata

## 🔧 Configuration

File `.env` sudah tersedia dengan:
- API keys dari ffmpeg-video-factory (working setup)
- yt-dlp path
- ffmpeg path
- Output directories

## 👁️ YOLOv8n Person Detection

Face/person detection sekarang disiapkan sebagai backend opsional yang portable:
- default tetap `heuristic`
- backend nyata menggunakan `YOLOv8n person detection`
- Node hanya memanggil script Python dan membaca hasil JSON
- desain ini memudahkan perpindahan dari Windows ke Docker Ubuntu

Panduan setup detail ada di `docs/YOLOV8_PERSON_DETECT.md`.

## 🎯 Usage

```bash
# Development
npm run dev "https://www.youtube.com/watch?v=VIDEO_ID"

# Production
npm run clip "https://www.youtube.com/watch?v=VIDEO_ID"

# Build only
npm run build

# Start compiled version
npm start
```

## 📦 Dependencies

```json
{
  "axios": "HTTP client untuk API calls",
  "dotenv": "Environment variables",
  "fluent-ffmpeg": "FFmpeg wrapper",
  "node-gtts": "Google Text-to-Speech",
  "pino": "Logger",
  "uuid": "Generate unique IDs"
}
```

## ✅ What's Ready

- ✅ Project structure modular dan clean
- ✅ All services implemented
- ✅ Environment configuration
- ✅ Error handling & fallbacks
- ✅ TypeScript compilation
- ✅ CLI entry point
- ✅ Full documentation

## 🔄 Next Steps (Optional Enhancements)

1. **Add API Server**: Create Express/Fastify server untuk REST API
2. **Database**: Store job results dan metadata
3. **Queue System**: Support batch processing dengan BullMQ
4. **Web Dashboard**: UI untuk submit URLs dan track progress
5. **Advanced AI**: Multi-language support, emotion detection, scene changes
6. **Custom Output**: Templates untuk different clip types

## 🧪 Testing

Siap untuk test dengan YouTube URL:

```bash
npm run dev "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
```

Output akan di `./output/` dengan struktur:
- `{jobId}.mp4` - Final video
- `{jobId}_thumb.jpg` - Thumbnail  
- Subtitles di temp folder

## 📝 Notes

- Single flow fokus: YouTube → Clips (tidak ada Flow 1 & 3 dari ffmpeg-video-factory)
- AI analysis proxied melalui Sumopod (consistent dengan setup existing)
- Video maksimal 60 detik (configurable)
- TTS fallback chain: gTTS → OpenAI → HuggingFace
- Temporary files di `./temp/`, output di `./output/`

---

**Status**: ✅ **Fully Functional - Ready to Use**
