FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ffmpeg \
        python3 \
        python3-pip \
        ca-certificates \
        curl \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./

RUN npm ci \
    && pip3 install --break-system-packages --no-cache-dir yt-dlp

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY assets ./assets
COPY yolov8n.pt ./yolov8n.pt
COPY .env.example ./.env.example

RUN chmod +x /app/scripts/docker-entrypoint.sh

RUN npm run build \
    && mkdir -p /app/temp /app/results /app/output /app/assets/music /app/assets/fonts

ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
