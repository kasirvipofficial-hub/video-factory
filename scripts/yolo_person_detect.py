import argparse
import json
import math
import statistics
import sys
from pathlib import Path


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run YOLOv8n person detection on sampled video frames")
    parser.add_argument("--video", required=True, help="Path to input video")
    parser.add_argument("--output", required=True, help="Path to output JSON")
    parser.add_argument("--model", default="yolov8n.pt", help="YOLO model path or model name")
    parser.add_argument("--sample-interval", type=float, default=1.0, help="Sample interval in seconds")
    parser.add_argument("--confidence", type=float, default=0.35, help="Confidence threshold")
    parser.add_argument("--max-frames", type=int, default=90, help="Maximum sampled frames")
    parser.add_argument("--imgsz", type=int, default=640, help="Inference image size")
    parser.add_argument("--device", default="", help="Inference device, e.g. cpu or cuda:0")
    return parser


def compute_iou(candidate, previous_box):
    if previous_box is None:
        return 0.0

    left = max(candidate["x"], previous_box["x"])
    top = max(candidate["y"], previous_box["y"])
    right = min(candidate["x"] + candidate["width"], previous_box["x"] + previous_box["width"])
    bottom = min(candidate["y"] + candidate["height"], previous_box["y"] + previous_box["height"])

    if right <= left or bottom <= top:
        return 0.0

    intersection = (right - left) * (bottom - top)
    candidate_area = candidate["width"] * candidate["height"]
    previous_area = previous_box["width"] * previous_box["height"]
    union = max(1.0, candidate_area + previous_area - intersection)
    return intersection / union


def choose_best_person(boxes, frame_width: int, frame_height: int, previous_box=None):
    frame_center_x = frame_width / 2.0
    frame_center_y = frame_height / 2.0
    best = None
    best_score = None

    for box in boxes:
        x1, y1, x2, y2 = [float(value) for value in box.xyxy[0].tolist()]
        confidence = float(box.conf[0].item())
        width = max(1.0, x2 - x1)
        height = max(1.0, y2 - y1)
        width_ratio = width / max(1.0, frame_width)
        height_ratio = height / max(1.0, frame_height)

        if width_ratio > 0.82 or height_ratio > 0.98:
            continue

        area = width * height
        center_x = x1 + width / 2.0
        center_y = y1 + height / 2.0
        distance = math.hypot(center_x - frame_center_x, center_y - frame_center_y)
        normalized_distance = distance / max(1.0, math.hypot(frame_center_x, frame_center_y))
        candidate = {
            "x": round(max(0.0, x1)),
            "y": round(max(0.0, y1)),
            "width": round(width),
            "height": round(height),
            "confidence": confidence,
        }

        continuity_bonus = 1.0
        if previous_box is not None:
            previous_center_x = previous_box["x"] + previous_box["width"] / 2.0
            continuity_penalty = abs(center_x - previous_center_x) / max(1.0, frame_width)
            overlap_bonus = 1.0 + compute_iou(candidate, previous_box)
            size_penalty = abs(width - previous_box["width"]) / max(1.0, frame_width)
            continuity_bonus = max(0.35, (1.0 - continuity_penalty) * overlap_bonus * max(0.65, 1.0 - size_penalty))

        score = area * (1.0 + confidence) * (1.0 - min(0.9, normalized_distance)) * continuity_bonus

        if best is None or score > best_score:
            best = candidate
            best_score = score

    return best


def smooth_detections(detections):
    if len(detections) < 3:
        return detections

    smoothed = []
    alpha = 0.65
    previous = None

    for detection in detections:
        current = dict(detection)
        if previous is None:
            smoothed.append(current)
            previous = current
            continue

        current["x"] = round(previous["x"] * alpha + current["x"] * (1.0 - alpha))
        current["y"] = round(previous["y"] * alpha + current["y"] * (1.0 - alpha))
        current["width"] = round(previous["width"] * alpha + current["width"] * (1.0 - alpha))
        current["height"] = round(previous["height"] * alpha + current["height"] * (1.0 - alpha))
        current["confidence"] = max(previous["confidence"] * 0.5, current["confidence"])

        smoothed.append(current)
        previous = current

    return smoothed


def calculate_crop_box(detections, frame_width: int, frame_height: int):
    if not detections:
        return {
            "x": round(frame_width * 0.22),
            "y": round(frame_height * 0.1),
            "width": round(frame_width * 0.56),
            "height": round(frame_height * 0.74),
        }

    centers_x = [detection["x"] + detection["width"] / 2.0 for detection in detections]
    centers_y = [detection["y"] + detection["height"] / 2.0 for detection in detections]
    widths = [detection["width"] for detection in detections]
    heights = [detection["height"] for detection in detections]

    median_center_x = statistics.median(centers_x)
    median_center_y = statistics.median(centers_y)
    median_width = statistics.median(widths)
    median_height = statistics.median(heights)

    crop_width = min(frame_width, round(median_width * 1.45))
    crop_height = min(frame_height, round(median_height * 1.35))
    crop_width = max(crop_width, round(frame_width * 0.22))
    crop_height = max(crop_height, round(frame_height * 0.42))

    min_x = max(0, round(median_center_x - crop_width / 2.0))
    min_y = max(0, round(median_center_y - crop_height * 0.42))
    max_x = min(frame_width, min_x + crop_width)
    max_y = min(frame_height, min_y + crop_height)

    min_x = max(0, max_x - crop_width)
    min_y = max(0, max_y - crop_height)

    return {
        "x": min_x,
        "y": min_y,
        "width": max(1, max_x - min_x),
        "height": max(1, max_y - min_y),
    }


def calculate_trajectory(detections, frame_width: int, frame_height: int):
    if not detections:
        return {
            "minX": 0,
            "maxX": frame_width,
            "minY": 0,
            "maxY": frame_height,
            "avgX": round(frame_width / 2),
            "avgY": round(frame_height / 2),
        }

    xs = [detection["x"] + detection["width"] / 2.0 for detection in detections]
    ys = [detection["y"] + detection["height"] / 2.0 for detection in detections]

    return {
        "minX": round(min(xs)),
        "maxX": round(max(xs)),
        "minY": round(min(ys)),
        "maxY": round(max(ys)),
        "avgX": round(sum(xs) / len(xs)),
        "avgY": round(sum(ys) / len(ys)),
    }


def main() -> int:
    args = build_arg_parser().parse_args()

    try:
        import cv2
        from ultralytics import YOLO
    except Exception as exc:
        print(f"Missing YOLO dependencies: {exc}", file=sys.stderr)
        return 2

    video_path = Path(args.video).resolve()
    output_path = Path(args.output).resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)

    if not video_path.exists():
        print(f"Input video not found: {video_path}", file=sys.stderr)
        return 2

    capture = cv2.VideoCapture(str(video_path))
    if not capture.isOpened():
        print(f"Could not open video: {video_path}", file=sys.stderr)
        return 2

    frame_width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    frame_height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    fps = float(capture.get(cv2.CAP_PROP_FPS) or 0.0)
    if fps <= 0:
        fps = 25.0

    sample_interval = max(0.1, args.sample_interval)
    sample_every = max(1, int(round(sample_interval * fps)))

    try:
        model = YOLO(args.model)
    except Exception as exc:
        print(f"Could not load YOLO model '{args.model}': {exc}", file=sys.stderr)
        capture.release()
        return 2

    detections = []
    frame_index = 0
    sampled_frames = 0
    predict_kwargs = {
        "source": None,
        "classes": [0],
        "conf": args.confidence,
        "verbose": False,
        "imgsz": args.imgsz,
    }
    if args.device:
        predict_kwargs["device"] = args.device

    previous_box = None

    while sampled_frames < max(1, args.max_frames):
        success, frame = capture.read()
        if not success:
            break

        if frame_index % sample_every != 0:
            frame_index += 1
            continue

        predict_kwargs["source"] = frame
        results = model.predict(**predict_kwargs)
        boxes = results[0].boxes if results else []
        best_person = choose_best_person(boxes, frame_width, frame_height, previous_box)

        if best_person is not None:
            previous_box = dict(best_person)
            detections.append({
                **best_person,
                "frame": frame_index + 1,
                "timestamp": round(frame_index / fps, 3),
            })

        sampled_frames += 1
        frame_index += 1

    capture.release()

    detections = smooth_detections(detections)

    result = {
        "backend": "yolov8n",
        "model": str(args.model),
        "sampleIntervalSeconds": sample_interval,
        "totalFrames": sampled_frames,
        "framesWithFaces": len(detections),
        "faceCount": len(detections),
        "facDetections": detections,
        "recommendedCropBox": calculate_crop_box(detections, frame_width, frame_height),
        "faceTrajectory": calculate_trajectory(detections, frame_width, frame_height),
    }

    output_path.write_text(json.dumps(result, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())