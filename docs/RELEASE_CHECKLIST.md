# Release Checklist

Checklist ini ditujukan untuk release operasional, bukan sekadar commit source code.

## Source Control

- [ ] Branch `main` dalam keadaan bersih
- [ ] Tidak ada secret hardcoded di source code atau dokumentasi
- [ ] `.env`, output runtime, dan hasil render tidak ikut ter-commit

## Build Validation

- [ ] Jalankan `npm ci`
- [ ] Jalankan `npm run build`
- [ ] Verifikasi tidak ada error TypeScript atau runtime import yang hilang

## Environment Validation

- [ ] `.env` sudah diisi dengan kredensial AI, Whisper, dan R2 yang valid
- [ ] `API_BEARER_TOKEN` sudah diganti dari placeholder
- [ ] `S3_PUBLIC_URL`, `S3_BUCKET`, dan credential R2 sudah benar
- [ ] `FACE_DETECTOR_BACKEND` dipilih sesuai target deployment

## Runtime Validation

- [ ] Redis berjalan dan bisa diakses oleh API/worker
- [ ] FFmpeg tersedia di runtime
- [ ] `yt-dlp` tersedia di runtime
- [ ] Jika memakai YOLO, Python dependency detector sudah terpasang secara eksplisit karena tidak ikut default image build

## Container Validation

- [ ] Jalankan `docker compose build`
- [ ] Jalankan `docker compose up -d redis api worker webhooks`
- [ ] Verifikasi `GET /health` mengembalikan status sehat
- [ ] Verifikasi worker memproses job dari queue

## Functional Validation

- [ ] Submit job `auto_best` dengan URL YouTube nyata
- [ ] Verifikasi customization `font` dan `filters` benar-benar memengaruhi hasil akhir
- [ ] Verifikasi `analysis.md` ter-upload ke R2
- [ ] Verifikasi video final ter-upload ke R2
- [ ] Verifikasi `GET /api/v1/jobs/:jobId/output` mengembalikan payload final lengkap
- [ ] Verifikasi folder `temp/` dan `results/` dibersihkan setelah sukses

## Publication

- [ ] README publik sesuai dengan perilaku sistem terbaru
- [ ] Dokumentasi setup cukup untuk operator baru
- [ ] Tag atau release note dibuat bila diperlukan
