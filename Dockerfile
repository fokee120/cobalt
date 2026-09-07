FROM ghcr.io/imputnet/cobalt:11

USER root

RUN apk add --no-cache ffmpeg yt-dlp

# Overlay our patched files onto the official Cobalt image
COPY --chown=node:node api/src/processing/services/youtube.js /app/src/processing/services/youtube.js
COPY --chown=node:node api/src/stream/internal.js /app/src/stream/internal.js

USER node

EXPOSE 9000

CMD ["node", "src/cobalt"]
