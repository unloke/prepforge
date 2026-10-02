// Deterministic template picking for generated copy (Scout summaries).
// Same input + same slot -> same template, so a report reads the same on every render.

export function fmt(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ""));
}

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// A per-slot deterministic seed: same move + same slot -> same pick, always. Different
// slots (different `salt`) vary independently, so picking a new "lead" doesn't lock in
// the same index for another slot.
export function seedFor(f, salt) {
  const base = Number.isFinite(f.ply) ? f.ply : hashStr((f.san || "") + (f.uci || ""));
  return hashStr(`${salt}:${f.san || ""}:${f.uci || ""}:${base}`);
}

export function pick(seed, bank) {
  return bank[((seed % bank.length) + bank.length) % bank.length];
}

// Pick a template from `bank` for this move+slot and fill it with `vars`.
export function choose(f, salt, bank, vars) {
  return fmt(pick(seedFor(f, salt), bank), vars || {});
}
