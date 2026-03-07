# Clipper

Clipper adalah service HTTP API + worker untuk memproses video YouTube menjadi short clip vertikal, mengunggah hasil final ke Cloudflare R2, lalu mengembalikan JSON yang siap dipakai untuk distribusi konten.

## Fitur Inti

- Input berupa `youtubeUrl` dan `customization`
- Discovery topic untuk video panjang dengan mode `auto_best`
- Render portrait 9:16 dengan subtitle karaoke
- Customisasi font subtitle dan filter video final
- Upload video final dan `analysis.md` ke R2
- Cleanup folder `temp/` dan `results/` setelah upload sukses
- API output siap posting: URL video, URL analisis, judul, caption, hashtag, durasi

## Quick Start

```bash
cp .env.example .env
docker compose build
docker compose up -d redis api worker webhooks
```

Health check:

```bash
curl http://localhost:8080/health
```

## Cloudflared

Jika Anda memakai Cloudflare Tunnel, service API cukup diekspos ke localhost host VPS. `docker-compose.yml` sudah diatur untuk bind API ke `127.0.0.1:8080`.

Tambahkan public hostname di dashboard tunnel Cloudflare Anda dengan target service:

```text
Hostname: <subdomain-anda>
Service: http://localhost:8080
```

Contoh ingress yang setara:

```yaml
ingress:
  - hostname: clipper.example.com
    service: http://localhost:8080
  - service: http_status:404
```

Setelah hostname dibuat, uji endpoint publik dengan:

```bash
curl https://<subdomain-anda>/health
```

## Request Example

```bash
curl -X POST http://localhost:8080/api/v1/jobs \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer change-me" \
  -d '{
    "youtubeUrl": "https://www.youtube.com/watch?v=VIDEO_ID",
    "mode": "auto",
    "selectionPolicy": "auto_best",
    "customization": {
      "targetPlatform": "tiktok",
      "postingTone": "tajam dan informatif",
      "targetAudience": "audiens politik Indonesia",
      "callToAction": "Setuju atau tidak?",
      "font": {
        "family": "Oswald",
        "size": 76,
        "stylePreset": "karaoke_yellow"
      },
      "filters": ["vignette", "sharpen"]
    }
  }'
```

## Output Contract

Ambil hasil final melalui `GET /api/v1/jobs/:jobId/output`.

```json
{
  "jobId": "...",
  "videoUrl": "https://cdn.example.com/clipper/<jobId>/final_video_portrait.mp4",
  "analysisUrl": "https://cdn.example.com/clipper/<jobId>/analysis.md",
  "postingTitle": "...",
  "caption": "...",
  "captionWithHashtags": "...",
  "hashtags": ["#clipper", "#shorts"],
  "duration": 126.341,
  "metadata": {
    "sourceTitle": "...",
    "highlights": 3
  }
}
```

## Komponen Runtime

- `api`: menerima request job dan endpoint status/output
- `worker`: menjalankan discovery, render, upload, cleanup
- `webhooks`: mengirim event job ke endpoint eksternal
- `redis`: broker BullMQ

## Prasyarat

- Node.js 18+ untuk mode non-container
- Docker + Docker Compose untuk deployment yang direkomendasikan
- FFmpeg
- yt-dlp
- kredensial AI, Whisper, dan Cloudflare R2 yang valid di `.env`

## Catatan Readiness

- Build TypeScript harus lolos dengan `npm run build`
- Docker stack baru bisa tervalidasi penuh bila Docker tersedia di host
- `.env.example` sudah aman untuk dipublikasikan karena berisi placeholder, bukan kredensial nyata

## Dokumen Tambahan

- `docs/SETUP.md` untuk setup dan contoh payload
- `docs/ARCHITECTURE.md` untuk gambaran arsitektur yang aktif
- `docs/REPOSITORY_AUDIT.md` untuk audit kesiapan repo publik
- `docs/RELEASE_CHECKLIST.md` untuk checklist release operasional
- `.env.example` untuk daftar variabel environment
- `docker-compose.yml` dan `install.sh` untuk bootstrap deployment
- `docs/archive/` untuk dokumen planning dan histori implementasi lama
