// Test helper for code that takes the shell state and its feature slices as
// separate injected objects. A test keeps one flat object of fields; asSlices
// hands the code a separate view per slice over it, and each view only reaches
// the fields its slice owns (slice-fields.fixture.js). A read through the wrong
// slice sees nothing and a write through it throws, so code that uses the wrong
// slice fails the test, while the test itself can still read the flat object.
import { SLICE_FIELDS, ownerName } from "./slice-fields.fixture.js";

export const SLICE_NAMES = Object.keys(SLICE_FIELDS).sort();

const backing = new WeakMap(); // slice view -> the flat object it reads
const owns = (name, key) => typeof key !== "string" || ownerName(key) === name;

function sliceView(state, name) {
  const refuse = (key) => {
    throw new TypeError(`${name}.${String(key)}: the field belongs to ${ownerName(key)}`);
  };
  const view = new Proxy(state, {
    get: (target, key) => (owns(name, key) ? Reflect.get(target, key) : undefined),
    set: (target, key, value) => (owns(name, key) ? Reflect.set(target, key, value) : refuse(key)),
    defineProperty: (target, key, descriptor) => (owns(name, key) ? Reflect.defineProperty(target, key, descriptor) : refuse(key)),
    deleteProperty: (target, key) => (owns(name, key) ? Reflect.deleteProperty(target, key) : refuse(key)),
    has: (target, key) => owns(name, key) && Reflect.has(target, key),
    ownKeys: (target) => Reflect.ownKeys(target).filter((key) => owns(name, key)),
    getOwnPropertyDescriptor: (target, key) => (owns(name, key) ? Reflect.getOwnPropertyDescriptor(target, key) : undefined),
  });
  backing.set(view, state);
  return view;
}

// `state` may be a view asSlices made; its slices then share that flat object.
export function asSlices(state = {}) {
  state = backing.get(state) || state;
  const out = { appState: sliceView(state, "appState") };
  for (const name of SLICE_NAMES) out[name] = sliceView(state, name);
  return out;
}

// The same views as positional arguments, in the order the tests' compiled
// source declares them: appState, analysisState, buildState, trainState,
// replayState, teamsState, settingsState.
export function sliceArgs(state) {
  const slices = asSlices(state);
  return ["appState", "analysisState", "buildState", "trainState", "replayState", "teamsState", "settingsState"].map((name) => slices[name]);
}
