FROM ghcr.io/imputnet/cobalt:11

USER root

RUN apk add --no-cache ffmpeg yt-dlp

# Overlay our patched files onto the official Cobalt image
COPY --chown=node:node api/src/processing/services/youtube.js /app/src/processing/services/youtube.js
COPY --chown=node:node api/src/stream/internal.js /app/src/stream/internal.js

# Make yt-dlp the primary resolver for audio-only YouTube requests.
# The script patches the overlaid youtube.js at image-build time.
COPY docker/patch-ytdlp-first.mjs /tmp/patch-ytdlp-first.mjs
RUN node /tmp/patch-ytdlp-first.mjs && rm /tmp/patch-ytdlp-first.mjs

USER node

EXPOSE 9000

CMD ["node", "src/cobalt"]
