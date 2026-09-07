import { readFileSync, writeFileSync } from 'node:fs';

const path = '/app/src/processing/services/youtube.js';
let source = readFileSync(path, 'utf8');

// Give yt-dlp enough time on cold starts / slower YouTube responses.
source = source.replace('}, 30000);', '}, 90000);');

// Prefer the mweb client so the installed PO-token provider can supply the
// video-bound GVS token yt-dlp currently recommends for YouTube downloads.
source = source.replace(
    "'--no-playlist',\n            '-f', 'bestaudio',",
    "'--no-playlist',\n            '--extractor-args', 'youtube:player_client=mweb',\n            '-f', 'bestaudio',"
);

const marker = 'export default async function (o) {\n';
if (!source.includes(marker)) throw new Error('youtube.js export marker not found');

const early = `export default async function (o) {\n    // Sonora primarily requests audio. Resolve it with yt-dlp first because\n    // it currently handles YouTube playability/challenge changes more reliably\n    // than the native Innertube path on cloud/datacenter hosts.\n    if (o.isAudioOnly && !o.subtitleLang && !o.dubLang) {\n        const ytDlpAudio = await resolveYtDlpAudio(o.id);\n        if (ytDlpAudio) {\n            console.info(\`[youtube] using yt-dlp primary audio source for \${o.id}\`);\n\n            // We still need Cobalt's normal metadata/filename pipeline below,\n            // so stash the already-resolved URL and let Innertube provide metadata.\n            o.__ytDlpPrimaryAudio = ytDlpAudio;\n        }\n    }\n`;
source = source.replace(marker, early);

const loginReturn = 'if (playability.reason.endsWith("bot")) {\n                return { error: "youtube.login" }\n            }';
const loginReplacement = 'if (playability.reason.endsWith("bot")) {\n                // If yt-dlp already resolved the stream, do not fail solely because\n                // Innertube hit the cloud-IP bot gate. Metadata may still be present,\n                // but if the native path cannot continue we fall back normally below.\n                if (!o.__ytDlpPrimaryAudio) return { error: "youtube.login" }\n            }';
source = source.replace(loginReturn, loginReplacement);

// Do not spawn yt-dlp a second time after it already succeeded at the start.
const late = `        const ytDlpAudio = await resolveYtDlpAudio(o.id);\n        if (ytDlpAudio) {\n            urls = ytDlpAudio;\n            bestAudio = ytDlpAudio.includes('mime=audio%2Fwebm') ? "opus" : bestAudio;\n        }`;
const lateReplacement = `        const ytDlpAudio = o.__ytDlpPrimaryAudio || await resolveYtDlpAudio(o.id);\n        if (ytDlpAudio) {\n            urls = ytDlpAudio;\n            bestAudio = ytDlpAudio.includes('mime=audio%2Fwebm') ? "opus" : bestAudio;\n        }`;
if (!source.includes(late)) throw new Error('late yt-dlp block not found');
source = source.replace(late, lateReplacement);

writeFileSync(path, source);
console.log('Applied yt-dlp-first YouTube audio patch with mweb PO-token support');
