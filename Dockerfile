FROM node:24-alpine AS bgutil-builder

RUN apk add --no-cache \
    git python3 make g++ pkgconfig \
    cairo-dev pango-dev jpeg-dev giflib-dev pixman-dev

RUN git clone --depth 1 --branch 1.3.2 \
    https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git /opt/bgutil

WORKDIR /opt/bgutil/server
RUN npm ci --no-audit --no-fund && npx tsc


FROM ghcr.io/imputnet/cobalt:11

USER root

# Runtime media tools plus Python environment for an up-to-date yt-dlp and
# its maintained bgutil PO-token plugin. The Alpine yt-dlp package was stale
# and could resolve URLs that Googlevideo then rejected with HTTP 403.
RUN apk add --no-cache \
    ffmpeg python3 py3-pip py3-virtualenv \
    cairo pango jpeg giflib pixman \
    && python3 -m venv /opt/ytdlp \
    && /opt/ytdlp/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/ytdlp/bin/pip install --no-cache-dir --upgrade \
       yt-dlp bgutil-ytdlp-pot-provider==1.3.2

ENV YT_DLP_PATH=/opt/ytdlp/bin/yt-dlp

# Copy the matching bgutil HTTP provider, built on Alpine so its native canvas
# dependency is compatible with Cobalt's Alpine runtime.
COPY --from=bgutil-builder --chown=node:node /opt/bgutil/server /opt/bgutil/server

# Overlay our patched files onto the official Cobalt image.
COPY --chown=node:node api/src/processing/services/youtube.js /app/src/processing/services/youtube.js
COPY --chown=node:node api/src/stream/internal.js /app/src/stream/internal.js

# Make yt-dlp the primary resolver for audio-only YouTube requests and select
# the recommended mweb client so bgutil can provide video-bound GVS PO tokens.
COPY docker/patch-ytdlp-first.mjs /tmp/patch-ytdlp-first.mjs
RUN node /tmp/patch-ytdlp-first.mjs && rm /tmp/patch-ytdlp-first.mjs

COPY --chown=node:node docker/start-with-bgutil.sh /usr/local/bin/start-cobalt
RUN chmod +x /usr/local/bin/start-cobalt

USER node

EXPOSE 9000

CMD ["/usr/local/bin/start-cobalt"]
