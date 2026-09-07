import { request } from "undici";
import { Readable } from "node:stream";
import { closeRequest, getHeaders, pipe } from "./shared.js";
import { handleHlsPlaylist, isHlsResponse, probeInternalHLSTunnel } from "./internal-hls.js";

const CHUNK_SIZE = BigInt(1e6); // 1 MB
const min = (a, b) => a < b ? a : b;

const serviceNeedsChunks = new Set(["youtube", "vk"]);

function parseContentRangeSize(contentRange) {
    const match = String(contentRange || '').match(/\/(\d+)$/);
    return match ? BigInt(match[1]) : 0n;
}

async function probeChunkedStream(streamInfo, signal) {
    let req, attempts = 3;
    while (attempts--) {
        req = await fetch(streamInfo.url, {
            headers: getHeaders(streamInfo.service),
            method: 'HEAD',
            dispatcher: streamInfo.dispatcher,
            signal
        });

        streamInfo.url = req.url;
        if (req.status === 403 && streamInfo.transplant) {
            try {
                await streamInfo.transplant(streamInfo.dispatcher);
            } catch {
                break;
            }
        } else break;
    }

    let size = BigInt(req.headers.get('content-length') || 0);
    if (req.status === 200 && size) {
        return { req, size };
    }

    const rangeProbe = await fetch(streamInfo.url, {
        headers: {
            ...getHeaders(streamInfo.service),
            Range: 'bytes=0-0'
        },
        dispatcher: streamInfo.dispatcher,
        signal
    });

    streamInfo.url = rangeProbe.url;
    size = parseContentRangeSize(rangeProbe.headers.get('content-range'));
    if (rangeProbe.status === 206 && size) {
        await rangeProbe.body?.cancel();
        return { req: rangeProbe, size };
    }

    await rangeProbe.body?.cancel();
    return { req, size: 0n };
}

async function* readChunks(streamInfo, size) {
    let read = 0n;
    while (read < size) {
        if (streamInfo.controller.signal.aborted) {
            throw new Error("controller aborted");
        }

        const end = min(read + CHUNK_SIZE - 1n, size - 1n);
        const chunk = await request(streamInfo.url, {
            headers: {
                ...getHeaders(streamInfo.service),
                Range: `bytes=${read}-${end}`
            },
            dispatcher: streamInfo.dispatcher,
            signal: streamInfo.controller.signal,
            maxRedirections: 4
        });

        if (chunk.statusCode === 403 && streamInfo.transplant) {
            chunk.body.on('error', () => {});
            chunk.body.destroy();
            try {
                await streamInfo.transplant(streamInfo.dispatcher);
                continue;
            } catch {}
        }

        const expected = end - read + 1n;
        const received = BigInt(chunk.headers['content-length']);

        if (received < expected / 2n) {
            closeRequest(streamInfo.controller);
        }

        for await (const data of chunk.body) {
            yield data;
        }

        read += received;
    }
}

async function handleChunkedStream(streamInfo, res) {
    const { signal } = streamInfo.controller;
    const cleanup = () => (res.end(), closeRequest(streamInfo.controller));

    try {
        const { req, size } = await probeChunkedStream(streamInfo, signal);

        if (!size) {
            return cleanup();
        }

        const generator = readChunks(streamInfo, size);

        const abortGenerator = () => {
            generator.return();
            signal.removeEventListener('abort', abortGenerator);
        }

        signal.addEventListener('abort', abortGenerator);

        const stream = Readable.from(generator);

        for (const headerName of ['content-type']) {
            const headerValue = req.headers.get(headerName);
            if (headerValue) res.setHeader(headerName, headerValue);
        }
        res.setHeader('content-length', size.toString());

        pipe(stream, res, cleanup);
    } catch {
        cleanup();
    }
}

async function handleGenericStream(streamInfo, res) {
    const { signal } = streamInfo.controller;
    const cleanup = () => res.end();

    try {
        const fileResponse = await request(streamInfo.url, {
            headers: {
                ...Object.fromEntries(streamInfo.headers),
                host: undefined
            },
            dispatcher: streamInfo.dispatcher,
            signal,
            maxRedirections: 16
        });

        res.status(fileResponse.statusCode);
        fileResponse.body.on('error', () => {});

        const isHls = isHlsResponse(fileResponse, streamInfo);

        for (const [ name, value ] of Object.entries(fileResponse.headers)) {
            if (!isHls || name.toLowerCase() !== 'content-length') {
                res.setHeader(name, value);
            }
        }

        if (fileResponse.statusCode < 200 || fileResponse.statusCode > 299) {
            return cleanup();
        }

        if (isHls) {
            await handleHlsPlaylist(streamInfo, fileResponse, res);
        } else {
            pipe(fileResponse.body, res, cleanup);
        }
    } catch {
        closeRequest(streamInfo.controller);
        cleanup();
    }
}

export function internalStream(streamInfo, res) {
    if (streamInfo.headers) {
        streamInfo.headers.delete('icy-metadata');
    }

    if (serviceNeedsChunks.has(streamInfo.service) && !streamInfo.isHLS) {
        return handleChunkedStream(streamInfo, res);
    }

    return handleGenericStream(streamInfo, res);
}

export async function probeInternalTunnel(streamInfo) {
    try {
        const signal = AbortSignal.timeout(3000);
        const headers = {
            ...Object.fromEntries(streamInfo.headers || []),
            ...getHeaders(streamInfo.service),
            host: undefined,
            range: undefined
        };

        if (streamInfo.isHLS) {
            return probeInternalHLSTunnel({
                ...streamInfo,
                signal,
                headers
            });
        }

        const response = await request(streamInfo.url, {
            method: 'HEAD',
            headers,
            dispatcher: streamInfo.dispatcher,
            signal,
            maxRedirections: 16
        });

        if (response.statusCode !== 200) {
            if (serviceNeedsChunks.has(streamInfo.service)) {
                const rangeProbe = await request(streamInfo.url, {
                    headers: {
                        ...headers,
                        Range: 'bytes=0-0'
                    },
                    dispatcher: streamInfo.dispatcher,
                    signal,
                    maxRedirections: 16
                });
                const size = Number(parseContentRangeSize(rangeProbe.headers['content-range']));
                rangeProbe.body.on('error', () => {});
                rangeProbe.body.destroy();
                if (!isNaN(size) && size > 0) return size;
            }
            throw "status is not 200 OK";
        }

        const size = +response.headers['content-length'];
        if (isNaN(size) || size <= 0)
            throw "content-length is not a positive number";

        return size;
    } catch {}
}
