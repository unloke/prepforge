// Brotli twins for the built static tree: every compressible file gets a
// `name.br` beside it, which api/static.py serves to clients that accept br.
// Quality 11 for normal assets; large binaries drop to 9, which keeps the build
// in seconds (the 23.7 MB ORT wasm → 3.96 MB in ~4 s). The 99 MB Stockfish
// big net only shrinks ~22% and costs minutes, so files above MAX_BYTES stay
// identity-only. A twin is kept only when it saves at least 10%.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import zlib from "node:zlib";

const brotli = promisify(zlib.brotliCompress);
const EXT = /\.(js|mjs|css|json|svg|wasm|txt|webmanifest)$/;
const MIN_BYTES = 1024;
const MAX_BYTES = 64 * 1024 * 1024;
const BIG = 4 * 1024 * 1024;

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

export async function precompress(dir) {
  const wanted = files(dir).filter((path) => EXT.test(path)
    && statSync(path).size >= MIN_BYTES && statSync(path).size <= MAX_BYTES);
  let raw = 0, packed = 0;
  await Promise.all(wanted.map(async (path) => {
    const body = readFileSync(path);
    const out = await brotli(body, { params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: body.length > BIG ? 9 : 11,
      [zlib.constants.BROTLI_PARAM_LGWIN]: 24,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: body.length,
    } });
    if (out.length > body.length * 0.9) return;
    writeFileSync(`${path}.br`, out);
    raw += body.length;
    packed += out.length;
  }));
  return { raw, packed };
}

export function precompressPlugin(outDir) {
  return {
    name: "precompress-brotli",
    apply: "build",
    closeBundle: {
      order: "post",
      sequential: true,
      async handler() {
        const { raw, packed } = await precompress(outDir);
        console.log(`[precompress] brotli ${(raw / 1e6).toFixed(1)} MB → ${(packed / 1e6).toFixed(1)} MB`);
      },
    },
  };
}
