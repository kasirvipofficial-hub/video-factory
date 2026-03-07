# YOLOv8n Person Detection Setup

Dokumen ini menjelaskan cara mengaktifkan backend `YOLOv8n person detection` secara ringan dan portable.

## Tujuan

- default app tetap ringan dengan backend `heuristic`
- YOLO hanya aktif saat portrait stage membutuhkan person detection
- setup tetap mudah dipindahkan dari Windows ke Docker Ubuntu
- jika YOLO gagal, pipeline otomatis fallback ke heuristic

## Backend Contract

Node memanggil script Python `scripts/yolo_person_detect.py` dan membaca JSON output.

Backend diaktifkan lewat `.env`:

```env
FACE_DETECTOR_BACKEND=yolov8n
FACE_DETECTOR_SAMPLE_INTERVAL_SECONDS=1
YOLO_PYTHON_PATH=python
YOLO_SCRIPT_PATH=./scripts/yolo_person_detect.py
YOLO_MODEL_PATH=yolov8n.pt
YOLO_CONFIDENCE_THRESHOLD=0.35
YOLO_MAX_FRAMES=90
YOLO_TIMEOUT_MS=180000
YOLO_IMAGE_SIZE=640
YOLO_DEVICE=
```

Target class yang dipakai adalah `person` pada YOLO class id `0`.

## Windows Setup

1. Install Python 3.11+.
2. Buat virtual environment:

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
```

3. Install dependency detector:

```powershell
pip install -r scripts\requirements-yolo.txt
```

4. Atur `.env`:

```env
FACE_DETECTOR_BACKEND=yolov8n
YOLO_PYTHON_PATH=.venv\Scripts\python.exe
```

5. Build dan jalankan app seperti biasa.

## Docker Ubuntu Setup

Saran paling aman: satu container yang berisi Node, Python, dan ffmpeg.

Catatan: image Docker default repo ini tidak meng-install dependency YOLO saat build standar. Ini disengaja agar deployment default tetap ringan dan cepat dengan backend `heuristic`.

Paket dasar yang dibutuhkan:
- python3
- python3-pip
- ffmpeg
- Node.js runtime

Install dependency detector saat build image:

```bash
pip install --no-cache-dir -r scripts/requirements-yolo.txt
```

Jika ingin mengaktifkan YOLO di container production, install dependency tersebut secara eksplisit pada image turunan atau provisioning tambahan sebelum mengubah `FACE_DETECTOR_BACKEND=yolov8n`.

Atur env container:

```env
FACE_DETECTOR_BACKEND=yolov8n
YOLO_PYTHON_PATH=python3
YOLO_SCRIPT_PATH=./scripts/yolo_person_detect.py
YOLO_MODEL_PATH=yolov8n.pt
```

## Performa Ringan

Nilai default dipilih agar inference tetap ringan:
- model `yolov8n`
- sample interval `1s`
- max frames `90`
- image size `640`

Untuk klip 60-90 detik, ini cukup baik untuk person framing tanpa membuat worker terlalu berat.

## Failure Mode

Jika Python, model, atau dependency YOLO gagal:
- log warning dicatat
- `FaceDetectorService` otomatis fallback ke `heuristic`
- pipeline clip tetap selesai

## Rollout Recommendation

1. Aktifkan dulu hanya di local/staging.
2. Uji beberapa URL portrait case.
3. Simpan `face_analysis.json` dan `portrait_decision.json` untuk membandingkan heuristic vs YOLO.
4. Setelah stabil, baru aktifkan di Docker Ubuntu.