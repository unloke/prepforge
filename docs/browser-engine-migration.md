# Browser engine implementation

The migration is implemented. This page describes current source locations; the
original phased plan is on the `history` branch.

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

Engine startup uses lite ×1 at the selected depth until the device's chosen net
is compiled and ready. `engine-assets.js` owns one compiled module per immutable
URL; `engine-profile.js` separates the saved recommendation from the usable
profile and publishes replayable setup progress for Settings. Analyze's job card
reports only the analysis work.

The first engine startup of a page prepares full in the background, then detection
requests an idle window from `compute-budget.js`. Foreground work cancels the
probe; it retries after that work finishes. A whole-game session pins its net
through all Maia follow-ups. Worker-count recovery stays on that net; a failure
requiring another net ends the session and records the next run's choice.
Remembered lite fallback skips automatic full preparation on later visits.
`navigator.connection.saveData` also skips automatic full preparation; Settings'
Full and Detect actions remain explicit ways to prepare it.
