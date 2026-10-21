// Node-only, three depth-16 searches; no network. Optional maximum in WASM pages.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const filename = path.resolve(__dirname, '../node_modules/stockfish/bin/stockfish-19.js');
const pages = Number(process.argv[2] || 32768);
const memories = [];
const Memory = WebAssembly.Memory;
WebAssembly.Memory = new Proxy(Memory, {
  construct(target, args) {
    const memory = Reflect.construct(target, args);
    memories.push(memory);
    return memory;
  },
});
const mod = new Module(filename, module);
mod.filename = filename;
mod.paths = module.paths;
mod._compile(fs.readFileSync(filename, 'utf8').replace('maximum:32768,shared:!0', `maximum:${pages},shared:!0`), filename);
let pending;
const memoryBytes = () => Math.max(...memories.map(m => m.buffer.byteLength));
const timeout = setTimeout(() => { console.error('smoke timeout'); process.exit(1); }, 45000);
(async () => {
  const engine = await mod.exports()({
    locateFile: name => name.endsWith('.wasm') ? filename.replace(/\.js$/, '.wasm') : filename,
    listener: line => { if (pending && pending.match(line)) { const p = pending; pending = null; p.resolve(line); } },
  });
  while (engine._isReady && !engine._isReady()) await new Promise(resolve => setTimeout(resolve, 10));
  const send = cmd => engine.ccall('command', null, ['string'], [cmd], { async: true });
  const command = (cmd, match) => new Promise(resolve => { pending = { match, resolve }; send(cmd); });
  await command('uci', line => line === 'uciok');
  await command('isready', line => line === 'readyok');
  console.log(JSON.stringify({ stage: 'loaded', maximumPages: pages, bytes: memoryBytes() }));
  send('position fen r1bq1rk1/ppp2ppp/2np1n2/4p3/2B1P3/2NP1N2/PPP2PPP/R1BQ1RK1 w - - 4 6');
  const probeStart = performance.now();
  await command('go nodes 400000', line => line.startsWith('bestmove '));
  const probeMs = performance.now() - probeStart;
  console.log(JSON.stringify({ stage: 'probe', nodes: 400000, ms: probeMs, nodesPerSecond: 400000000 / probeMs, bytes: memoryBytes() }));
  send('ucinewgame');
  for (const fen of [
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    'r1bq1rk1/ppp2ppp/2np1n2/4p3/2B1P3/2NP1N2/PPP2PPP/R1BQ1RK1 w - - 4 6',
    '8/5pk1/6p1/3R4/4r3/6P1/5PK1/8 w - - 0 40',
  ]) {
    send('position fen ' + fen);
    const start = performance.now();
    await command('go depth 16', line => line.startsWith('bestmove '));
    console.log(JSON.stringify({ fen, ms: Math.round(performance.now() - start), bytes: memoryBytes() }));
  }
  clearTimeout(timeout);
  engine.terminate();
  process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });
