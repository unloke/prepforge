// Renders every sound cue offline in Chromium and prints what each one does to
// the waveform — attack, decay, peak, RMS, tail, clipping — then writes the
// cues as 16-bit WAVs (default tmp/sounds/) so they can be listened to.
//
//   node scripts/sound-cues.mjs [--wav DIR] [--seconds N]
//
// A cue that clips, ends on a non-zero sample (an audible click) or sits far
// from the others' RMS is a bug in web-src/core/sound.js.
import { mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const WAV_DIR = join(ROOT, opt("--wav", "tmp/sounds"));
const SECONDS = Number(opt("--seconds", 1.4));
const RATE = 48000;

// The page under test: the real module, rendered into an OfflineAudioContext,
// measured where the samples are so only the numbers travel back.
const HARNESS = `<!doctype html><meta charset="utf-8">
<script type="importmap">{"imports":{"chess.js":"/node_modules/chess.js/dist/esm/chess.js"}}</script>
<script type="module">
import { CUE_NAMES, renderCue } from "/web-src/core/sound.js";

const RATE = ${RATE}, SECONDS = ${SECONDS};

// Naive Goertzel over log-spaced bins: enough to say how bright a cue is.
function centroid(x) {
  const bins = [];
  for (let f = 60; f < 16000; f *= 1.15) bins.push(f);
  let weighted = 0, total = 0;
  for (const f of bins) {
    const w = (2 * Math.PI * f) / RATE, coeff = 2 * Math.cos(w);
    let s1 = 0, s2 = 0;
    for (let i = 0; i < x.length; i += 2) {
      const s0 = x[i] + coeff * s1 - s2;
      s2 = s1; s1 = s0;
    }
    const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
    weighted += f * power; total += power;
  }
  return Math.round(total ? weighted / total : 0);
}

// BS.1770 K-weighting (the two pre-filter stages a loudness meter uses), then
// the loudest 400 ms block read as momentary loudness. This is the number the
// rule about the cues being within 1.5 dB is stated in, so it belongs here.
const K_BIQUAD = (sampleRate, b, a) => {
  // direct-form I coefficients normalised by a0, applied in place by runK
  return { b: b.map((v) => v / a[0]), a: a.slice(1).map((v) => v / a[0]) };
};
function runK(x, { b, a }) {
  const y = new Float64Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b[0] * x[i] + b[1] * x1 + b[2] * x2 - a[0] * y1 - a[1] * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}
// The meter's coefficients for 48 kHz (BS.1770-4 Table 1 and the RLB high-pass).
const K_STAGE1 = K_BIQUAD(RATE, [1.53512485958697, -2.69169618940638, 1.19839281085285],
  [1, -1.69065929318241, 0.73248077421585]);
const K_STAGE2 = K_BIQUAD(RATE, [1, -2, 1], [1, -1.99004745483398, 0.99007225036621]);
function lufs(x) {
  const y = runK(runK(x, K_STAGE1), K_STAGE2);
  let sum = 0;
  for (const v of y) sum += v * v;
  // A cue shorter than 400 ms is zero-padded to the meter's window, as a meter does.
  const n = Math.max(y.length, Math.round(RATE * 0.4));
  return +(-0.691 + 10 * Math.log10(sum / n + 1e-24)).toFixed(1);
}

function measure(x) {
  let peak = 0, peakAt = 0, clipped = 0;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]);
    if (a > peak) { peak = a; peakAt = i; }
    if (a >= 0.999) clipped += 1;
  }
  let last = 0;
  for (let i = x.length - 1; i >= 0; i--) if (Math.abs(x[i]) > peak * 0.003) { last = i; break; }
  const tail = x.slice(Math.max(0, last - Math.round(RATE * 0.005)), last + 1)
    .reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  let sum = 0, dc = 0;
  for (let i = 0; i <= last; i++) { sum += x[i] * x[i]; dc += x[i]; }
  const rms = Math.sqrt(sum / Math.max(1, last + 1));
  // Loudness proxy that treats a knock and a tone alike: the loudest 50 ms of
  // either, which is how much sound arrives while an ear is paying attention.
  const window = Math.min(Math.round(RATE * 0.05), last + 1);
  let loud = 0;
  for (let i = 0; i + window <= last + 1; i += Math.max(1, window >> 2)) {
    let block = 0;
    for (let j = i; j < i + window; j++) block += x[j] * x[j];
    loud = Math.max(loud, Math.sqrt(block / window));
  }
  // A click at the end is a step in the dying tail; the attack itself is meant
  // to be abrupt.
  let from = last;
  while (from > 0 && Math.abs(x[from]) < peak * 0.1) from -= 1;
  let jump = 0;
  for (let i = from + 1; i <= last; i++) jump = Math.max(jump, Math.abs(x[i] - x[i - 1]));
  return {
    peakMs: +((peakAt / RATE) * 1000).toFixed(1),
    lengthMs: +((last / RATE) * 1000).toFixed(0),
    peakDb: +(20 * Math.log10(peak || 1e-9)).toFixed(1),
    rmsDb: +(20 * Math.log10(rms || 1e-9)).toFixed(1),
    loudDb: +(20 * Math.log10(loud || 1e-9)).toFixed(1),
    lufs: lufs(x.subarray(0, last + 1)),
    tailDb: +(20 * Math.log10(tail || 1e-9)).toFixed(1),
    jump: +jump.toFixed(3),
    dc: +(dc / Math.max(1, last + 1)).toFixed(4),
    centroidHz: centroid(x.subarray(0, last + 1)),
    clipped,
    samples: x.subarray(0, last + Math.round(RATE * 0.02)),
  };
}

function pcm16(x) {
  const bytes = new Uint8Array(x.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < x.length; i++) {
    view.setInt16(i * 2, Math.max(-1, Math.min(1, x[i])) * 0x7fff, true);
  }
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

// Two cues overlap for the few milliseconds a cut takes; this renders that
// overlap the way the player does it, to prove the sum stays under full scale.
window.overlap = async (name, gapMs) => {
  const ctx = new OfflineAudioContext(1, Math.ceil(RATE * SECONDS), RATE);
  const first = renderCue(ctx, name, ctx.destination, 0);
  const at = gapMs / 1000;
  first.gain.cancelScheduledValues(at);
  first.gain.setValueAtTime(first.gain.value, at);
  first.gain.exponentialRampToValueAtTime(0.0001, at + 0.015);
  renderCue(ctx, name, ctx.destination, at);
  const x = (await ctx.startRendering()).getChannelData(0);
  let peak = 0, clipped = 0;
  for (const v of x) {
    peak = Math.max(peak, Math.abs(v));
    if (Math.abs(v) >= 0.999) clipped += 1;
  }
  return { gapMs, peakDb: +(20 * Math.log10(peak || 1e-9)).toFixed(1), clipped };
};

window.CUES = CUE_NAMES;
window.render = async (name) => {
  const ctx = new OfflineAudioContext(1, Math.ceil(RATE * SECONDS), RATE);
  renderCue(ctx, name, ctx.destination, 0);
  const { samples, ...metrics } = measure((await ctx.startRendering()).getChannelData(0));
  return { metrics, pcm: pcm16(samples) };
};

// The app starts a cue at an arbitrary moment of the clock. Stacked sine
// oscillators used to land in a different phase every play (the same tap came
// out anywhere from 0.46 to 1.23 in peak, 8 dB apart); every cue must now come
// out the same wherever it starts. Offline, a start is quantised to the render
// quantum, so one offset inside each of the first few blocks is enough.
window.stability = async (name) => {
  const peaks = [];
  for (const block of [0, 1, 2, 3, 5, 13]) {
    const when = (block * 128 + 64) / RATE;
    const ctx = new OfflineAudioContext(1, Math.ceil(RATE * SECONDS), RATE);
    renderCue(ctx, name, ctx.destination, when);
    const x = (await ctx.startRendering()).getChannelData(0);
    let peak = 0;
    for (const v of x) peak = Math.max(peak, Math.abs(v));
    peaks.push(peak);
  }
  const lo = Math.min(...peaks), hi = Math.max(...peaks);
  return { peakSpreadDb: +(20 * Math.log10(hi / lo)).toFixed(2) };
};
</script>`;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function serve() {
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, "http://local").pathname);
    if (path === "/") {
      res.writeHead(200, { "content-type": TYPES[".html"] });
      res.end(HARNESS);
      return;
    }
    const file = normalize(join(ROOT, path));
    if (!file.startsWith(ROOT)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

// The listening page the owner opens: the real cues, the throttle included, so
// what is heard here is what the app plays. It is served from the repo root
// because it imports web-src/core/sound.js straight from source.
const PLAYER = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PrepForge sound cues</title>
<link rel="icon" href="data:,">
<style>
  body { font: 15px/1.5 system-ui, sans-serif; margin: 40px; color: #222; }
  h1 { font-size: 18px; margin: 0 0 16px; }
  .row { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
  button { font: inherit; padding: 7px 14px; border: 1px solid #bbb; border-radius: 8px; background: #fff; cursor: pointer; }
  button:hover { border-color: #666; }
</style>
</head>
<body>
<h1>Sound cues</h1>
<div class="row" id="cues"></div>
<div class="row">
  <button id="fast" type="button">A move list stepped fast (one cue at a time)</button>
</div>
<script type="importmap">
  { "imports": { "chess.js": "/node_modules/chess.js/dist/esm/chess.js" } }
</script>
<script type="module">
  import { CUE_NAMES, playSound } from "/web-src/core/sound.js";
  const cues = document.getElementById("cues");
  for (const cue of CUE_NAMES) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = cue;
    button.addEventListener("click", () => playSound(cue));
    cues.appendChild(button);
  }
  // The throttle, audibly: 20 taps 50 ms apart should sound like taps.
  document.getElementById("fast").addEventListener("click", () => {
    for (let i = 0; i < 20; i += 1) setTimeout(() => playSound("move"), i * 50);
  });
</script>
</body>
</html>
`;

// A three-line static server for that page, so the owner needs no tooling.
const SERVER = `// Serves the repo root for the cue page:  node tmp/sounds/serve.mjs
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

const ROOT = import.meta.dirname + "/../..";
const PORT = 8799;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8" };
const MIME = { ...TYPES, ".json": "application/json" };
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const file = normalize(join(ROOT, path === "/" ? "/tmp/sounds/index.html" : path));
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
server.listen(PORT, "127.0.0.1", () =>
  console.log(\`open http://127.0.0.1:\${PORT}/tmp/sounds/index.html\`));
`;

function wav(pcm, rate) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

const { server, port } = await serve();
// Same browser fallback the UI smokes use: a system Chrome/Edge satisfies
// WebAudio just as well as the bundled Chromium.
let browser;
for (const channel of ["msedge", "chrome", undefined]) {
  try {
    browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
    break;
  } catch { /* next */ }
}
if (!browser) {
  server.close();
  console.error("no chromium-based browser available");
  process.exit(2);
}
try {
  const page = await browser.newPage();
  page.on("pageerror", (error) => console.error(`page error: ${error.message}`));
  await page.goto(`http://127.0.0.1:${port}/`);
  const cues = await page.evaluate(() => window.CUES);
  mkdirSync(WAV_DIR, { recursive: true });

  const rows = [];
  let bytes = 0;
  for (const cue of cues) {
    const { metrics, pcm } = await page.evaluate((name) => window.render(name), cue);
    const { peakSpreadDb } = await page.evaluate((name) => window.stability(name), cue);
    const audio = wav(Buffer.from(pcm, "base64"), RATE);
    writeFileSync(join(WAV_DIR, `${cue}.wav`), audio);
    bytes += audio.length;
    rows.push({ cue, ...metrics, peakSpreadDb, wavBytes: audio.length });
  }

  console.table(rows);
  const overlaps = [];
  for (const cue of ["move", "capture"]) {
    for (const gap of [5, 10, 20, 40]) {
      overlaps.push({ cue, ...(await page.evaluate(([n, g]) => window.overlap(n, g), [cue, gap])) });
    }
  }
  console.table(overlaps);
  writeFileSync(join(WAV_DIR, "index.html"), PLAYER);
  writeFileSync(join(WAV_DIR, "serve.mjs"), SERVER);
  console.log(`${cues.length} cues, ${(bytes / 1024).toFixed(0)} KiB of WAV in ${WAV_DIR}`);
  console.log(`listen: node ${join(WAV_DIR, "serve.mjs")}`);
  console.log("columns: peak/rms/tail in dBFS, jump = largest sample step during the decay, dc = mean");
} finally {
  await browser.close();
  server.close();
}
