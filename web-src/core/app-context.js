// The contracts the app shell gives the controllers it lazy-loads.
//
// Three, each a fixed list of named capabilities:
//   - shell: what only app.js can do: switch the view, keep the URL and the
//     view heads in step, open a Settings section;
//   - persistence: the outbox queues Build edits and Train attempts go through;
//   - handoffs: one feature asking another for a result, by intent (open this
//     game in Analyze, the repertoire listing changed, make a repertoire from a PGN).
//
// Everything else a controller needs is its own feature's module, identity
// (account-entry.js), shared state and services (core/, board/, engine/), or a
// dependency its factory is given. app.js registers the contracts once at boot
// with provideApp(); a member forwards to the registered function at call time,
// so nothing is copied into module state, and a test registers its fakes the same
// way. Registering a name outside a contract throws: the contracts only grow on
// purpose.

const CONTRACTS = {
  shell: ["switchView", "syncWorkspaceUrl", "syncViewHeads", "openSettingsSection"],
  persistence: ["scheduleBuildFlush", "hardFlushBuild", "flushTrainSync", "queueTrainAttempt", "markTrainPositionDirty"],
  handoffs: ["openAnalyzeGame", "repertoiresChanged", "defaultRepertoireNameFromPgn", "importRepertoireFromPgnText"],
};

const registered = {};

function contract(name) {
  const impl = registered[name] = {};
  return Object.freeze(Object.fromEntries(CONTRACTS[name].map((member) => [member, (...args) => {
    if (typeof impl[member] !== "function") throw new Error(`${name}.${member} is not registered`);
    return impl[member](...args);
  }])));
}

export const shell = contract("shell");
export const persistence = contract("persistence");
export const handoffs = contract("handoffs");

export function provideApp(parts) {
  for (const [name, members] of Object.entries(parts)) {
    if (!CONTRACTS[name]) throw new Error(`No app contract named ${name}`);
    for (const member of Object.keys(members)) {
      if (!CONTRACTS[name].includes(member)) throw new Error(`${name}.${member} is not part of the ${name} contract`);
    }
    Object.assign(registered[name], members);
  }
}
