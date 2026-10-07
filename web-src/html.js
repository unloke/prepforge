const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const unsafe = /[&<>"']/;
const matches = /[&<>"']/g;
class SafeHtml {
  constructor(value) { this.value = value; }
  toString() { return this.value; }
}
// Only for trusted markup produced outside html; nested html needs no wrapper.
export const raw = (value) => new SafeHtml(value);
function escape(value) {
  if (typeof value !== "string") {
    if (typeof value === "number" || typeof value === "boolean") return value;
    if (value instanceof SafeHtml) return value.value;
    if (Array.isArray(value)) return value.map(escape).join("");
    value = String(value ?? "");
  }
  return unsafe.test(value) ? value.replace(matches, (char) => entities[char]) : value;
}
export function html(strings, ...values) {
  let result = strings[0];
  for (let i = 0; i < values.length; i++) result = result + escape(values[i]) + strings[i + 1];
  return new SafeHtml(result);
}
