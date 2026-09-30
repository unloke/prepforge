# Browser engine implementation

The migration is implemented. This page describes current source locations;
the original phased plan and its provisional decisions are
[archived](archive/history/browser-engine-migration.md).

- Stockfish: `web-src/engine/stockfish-provider.js`; assets and manifest are synced
  by `scripts/sync-stockfish.mjs` from the installed Stockfish package.
- Maia3: `maia3-provider.js` owns the worker; `maia3-worker.js` and
  `maia3-inference.js` run ONNX inference; the tokenizer prepares chess inputs.
- Model fetch, verification and cache: `maia3-weights-loader.js` and
  `maia3-weight-cache.js`, using the current model manifest and IndexedDB.
- Whole-game analysis: `game-analyzer.js` computes evaluations before the API
  classifies and saves them. Per-position depth and nodes reflect actual search.
- Repertoire generation: `build-generator.js` and `build-generate-runner.js`
  produce a browser plan which the API validates and applies.
- Export and parity tooling: `scripts/export_maia3_onnx.py`, the provider harness,
  and the existing engine tests/smokes.

The public/default flow currently computes engines in the browser. Legacy plan
references to server engine endpoints, unfinished phases, or provisional artifact
choices are not descriptions of current endpoints or new product requirements.
Use the live configuration and manifests to determine available backends and assets.

Engine glue/worker lifecycle and cross-origin asset behavior are covered by
provider and browser smoke checks. See `package.json`, CI, and
[deployment configuration](DEPLOYMENT.md) for commands and environment variables.
Large model/runtime assets are hosted separately from the server package.
