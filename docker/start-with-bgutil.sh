#!/bin/sh
set -eu

echo "[startup] starting bgutil PO-token provider on port 4416"
node /opt/bgutil/server/build/main.js --port 4416 &
BGUTIL_PID=$!

# Give the provider a short head start. Any HTTP response proves the server
# socket is listening; yt-dlp will then talk to it through the provider plugin.
i=0
while [ "$i" -lt 20 ]; do
    if node -e "fetch('http://127.0.0.1:4416/').then(()=>process.exit(0)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
        echo "[startup] bgutil PO-token provider ready"
        break
    fi
    if ! kill -0 "$BGUTIL_PID" 2>/dev/null; then
        echo "[startup] bgutil HTTP provider exited unexpectedly"
        break
    fi
    i=$((i + 1))
    sleep 1
done

exec node src/cobalt
