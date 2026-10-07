import { expect, it } from "vitest";
import { Linter } from "eslint";
import config from "../eslint.config.js";

const { plugins, rules } = config.find((entry) => entry.plugins);
const lint = (code) => new Linter().verify(code, {
  plugins, rules: { "local/html-templates": rules["local/html-templates"] },
});
it.each([
  'el.innerHTML = `<b>${name}</b>`',
  'el["outerHTML"] += `<b>${name}</b>`',
  'el.insertAdjacentHTML("beforeend", `<b>${name}</b>`)',
  'el["insertAdjacentHTML"]("beforeend", ok ? `<b>${name}</b>` : "")',
  'el.innerHTML = "<b>" + `${name}` + "</b>"',
  'el.innerHTML = rows.map(name => `<b>${name}</b>`).join("")',
])("rejects unsafe HTML templates: %s", (code) => {
  expect(lint(code)).toHaveLength(1);
});
it.each([
  'el.innerHTML = html`<b>${name}</b>`',
  'el.outerHTML = "<b>Static</b>"',
  'el.insertAdjacentHTML("beforeend", `<b>Static</b>`)',
  'el.innerHTML = rows.map(name => html`<b>${name}</b>`).join("")',
  'el.innerHTML = html`<b>${`${name}: ${count}`}</b>`',
  'el.textContent = `${name}`',
])("allows safe templates: %s", (code) => {
  expect(lint(code)).toEqual([]);
});

const lintRaw = (code) => new Linter().verify(code, {
  plugins, rules: { "local/trusted-raw": "error" },
});
it.each(['raw(data)', 'raw(html`<b>${name}</b>`)', 'raw(items.map(i => html`<b>${i}</b>`))'])
  ("requires a reason for a raw escape hatch: %s", (code) => {
    expect(lintRaw(code)).toHaveLength(1);
  });
it("accepts literal markup and a documented authored SVG boundary", () => {
  expect(lintRaw('raw("<br>")')).toEqual([]);
  expect(lintRaw('// eslint-disable-next-line local/trusted-raw -- Paths are authored SVG constants.\nraw(paths[piece])')).toEqual([]);
  expect(lintRaw('// eslint-disable-next-line local/trusted-raw\nraw(paths[piece])')).toHaveLength(1);
});
