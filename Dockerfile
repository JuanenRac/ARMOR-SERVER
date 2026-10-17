# ARMOR-SERVER production container build.
# Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    ARMOR_HOST=0.0.0.0 \
    ARMOR_PORT=8080 \
    ARMOR_DATA_DIR=/data \
    ARMOR_FFMPEG_PATH=/usr/bin/ffmpeg
# FFmpeg is what turns a camera's RTSP stream into the live picture, the snapshots, the recordings, the photos taken when something is seen and the frames for the observation
# service: without it the container runs but every one of those answers that video is off.
RUN apt-get update && apt-get install --yes --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && mkdir -p /data && chown node:node /data
COPY --from=build /app/dist ./dist
USER node
VOLUME ["/data"]
EXPOSE 8080
# With the server's own TLS (TLS_CERT_PATH and TLS_KEY_PATH) it speaks only HTTPS: the check asks over HTTPS and does not verify the certificate, because it only ever asks 127.0.0.1.
HEALTHCHECK --interval=30s --timeout=4s --start-period=10s --retries=3 \
  CMD node -e "const tls=process.env.TLS_CERT_PATH&&process.env.TLS_KEY_PATH;require(tls?'https':'http').get({host:'127.0.0.1',port:process.env.ARMOR_PORT||8080,path:'/healthz',rejectUnauthorized:false,timeout:3000},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1)).on('timeout',function(){this.destroy()})"
CMD ["node", "dist/server.mjs"]
