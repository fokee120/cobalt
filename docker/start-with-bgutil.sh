#!/bin/sh
set -eu

echo "[startup] starting bgutil PO-token provider on 127.0.0.1:4416"
node /opt/bgutil/server/build/main.js --host 127.0.0.1 --port 4416 &
BGUTIL_PID=$!

# Give the provider a short head start. If HTTP mode fails, yt-dlp also has
# the same provider's script mode configured as a fallback.
i=0
while [ "$i" -lt 20 ]; do
    if node -e "fetch('http://127.0.0.1:4416/ping').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
        echo "[startup] bgutil PO-token provider ready"
        break
    fi
    if ! kill -0 "$BGUTIL_PID" 2>/dev/null; then
        echo "[startup] bgutil HTTP provider exited; yt-dlp will use script-provider fallback"
        break
    fi
    i=$((i + 1))
    sleep 1
done

exec node src/cobalt
