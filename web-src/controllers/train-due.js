import { html } from "../html.js";
import { countOf } from "../plural.js";

// What a Start of the Due row would serve, or why it cannot. The button says
// the verb; how many cards it holds is the row's own line (dueMeta), so Resume
// does not repeat the count inside a button label.
export function dueStartState(next, { signedIn, hasRepertoire }) {
  if (!signedIn) return { label: "Sign in to train", action: "signin" };
  if (!hasRepertoire) return { label: "Open Library", action: "library" };
  if (next && Number(next.cards) === 0) return { label: "Open Repertoire", action: "build" };
  if (next?.resumed) return { label: "Resume", action: "start" };
  return { label: "Start", action: "start" };
}

// What a Start would serve. The outlook above already counts what is due, so
// this line says the one thing it cannot: how many cards the session holds.
export function dueMeta(next) {
  if (!next) return "";
  if (Number(next.cards) === 0) return "Nothing due";
  return next.resumed ? `${countOf(next.left, "card")} left` : countOf(next.cards, "card");
}

// "in 40 min", "in 5 h", "tomorrow", "in 3 days".
export function dueIn(iso, now = Date.now()) {
  const minutes = Math.max(1, Math.round((Date.parse(iso) - now) / 60000));
  if (minutes < 60) return `in ${minutes} min`;
  if (minutes < 24 * 60) return `in ${Math.round(minutes / 60)} h`;
  const days = Math.round(minutes / (24 * 60));
  return days === 1 ? "tomorrow" : `in ${days} days`;
}

export function outlookShape(outlook) {
  if (!outlook) return "none";
  if (!outlook.now && !outlook.today && !outlook.week) return outlook.next ? "quiet" : "none";
  const rest = Number(outlook.today) > Number(outlook.now) || Number(outlook.week) > Number(outlook.today);
  return rest ? "lead-rest" : "lead";
}

// The Due row's one figure and the two that follow it. "Due now" is what the
// row is about, so it is the figure in ink and the only one at full size; the
// two horizons behind it are a quieter line, not two more tiles beside it.
export function outlookHtml(outlook, now = Date.now()) {
  const shape = outlookShape(outlook);
  if (shape === "none") return "";
  if (shape === "quiet") return html`<span class="train-outlook-quiet">Nothing due · next ${dueIn(outlook.next, now)}</span>`;
  const rest = [];
  if (Number(outlook.today) > Number(outlook.now)) rest.push(`${outlook.today} by tonight`);
  if (Number(outlook.week) > Number(outlook.today)) rest.push(`${outlook.week} this week`);
  return html`<span class="train-outlook-lead"><b>${outlook.now}</b> due now</span>${rest.length
    ? html`<span class="train-outlook-rest">${rest.join(" · ")}</span>`
    : ""}`;
}
