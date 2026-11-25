import { hooks } from "../core/hooks.js";
const PREVIEW_TTL = 30000;

export function createTrainPreview(api) {
  let data = null;
  let dataKey = "";
  let requestedKey = "";
  let at = 0;
  let pending = null;
  let errorKey = "";
  let authKey = "";

  return {
    dataFor: (key) => dataKey === key ? data : null,
    failed: (key) => errorKey === key,
    authFailed: (key) => authKey === key,
    current: (key) => requestedKey === key,
    invalidate() {
      data = null;
      dataKey = "";
      at = 0;
      errorKey = "";
      authKey = "";
      pending = null;
      requestedKey = "";
    },
    load(key) {
      requestedKey = key;
      errorKey = "";
      authKey = "";
      if (pending && pending.key !== key) pending = null;
      if (dataKey === key && Date.now() - at < PREVIEW_TTL) return Promise.resolve(data);
      if (pending?.key === key) return pending.promise;
      let result;
      try { result = api(key); } catch (error) { result = Promise.reject(error); }
      const request = { key, promise: null };
      pending = request;
      request.promise = Promise.resolve(result).then((result) => {
        if (pending !== request) return null;
        data = result;
        dataKey = key;
        at = Date.now();
        return result;
      }).catch((error) => {
        if (pending === request) {
          if (error?.authRequired) { authKey = key; hooks.authRequired?.(); }
          else errorKey = key;
          at = 0;
        }
        return null;
      }).finally(() => { if (pending === request) pending = null; });
      return request.promise;
    },
  };
}

const HOME_CONTROL_IDS = [
  "start-train", "train-due-scope", "start-rehearse", "train-rehearse-scope",
  "start-play", "train-play-book", "train-play-reps", "feeling-lucky",
];

function skeletonControl(el, busy) {
  if (!el) return;
  if (busy) {
    el.classList.add("skeleton-control");
    el.setAttribute("inert", "");
    return;
  }
  if (!el.classList.contains("skeleton-control")) return;
  el.classList.remove("skeleton-control");
  el.removeAttribute("inert");
}

// Train Home's first paint is one coherent loading surface: stable chrome
// stays real, while every control whose label or availability depends on the
// repertoire listing is inert and masked in place. A later refresh over real
// content never uses this state; it keeps the content and marks only the row
// being refreshed busy.
export function paintTrainStartLoading(busy) {
  skeletonControl(document.getElementById("start-train"), busy);
}

export function paintTrainListingDependentLoading(busy) {
  for (const id of ["start-train", "train-due-scope", "start-rehearse", "train-rehearse-scope"]) skeletonControl(document.getElementById(id), busy);
}

export function paintTrainListingLoading(owner, scope, retrying = false, practiceUsable = false) {
  if (retrying) paintTrainListingDependentLoading(true);
  else {
    paintTrainHomeLoading(true);
    if (practiceUsable) skeletonControl(document.getElementById("start-play"), false);
    skeletonControl(document.querySelector?.("#train-bots [data-book='maia']"), false);
  }
  paintTrainPreviewLoading(true, readTrainPreviewShape(owner, scope));
}

export function paintTrainHomeLoading(busy) {
  const home = document.getElementById("train-home");
  if (!home) return;
  home.classList.toggle("is-loading", busy);
  if (busy) home.setAttribute("aria-busy", "true");
  else home.removeAttribute("aria-busy");
  for (const id of HOME_CONTROL_IDS) skeletonControl(document.getElementById(id), busy);
  for (const bot of document.querySelectorAll?.("#train-bots .train-bot") || []) skeletonControl(bot, busy);
}

function previewShapeKey(owner, scope) {
  return `prepforge.train-preview-shape.${encodeURIComponent(owner || "guest")}.${encodeURIComponent(scope || "mixed")}`;
}

const OUTLOOK_SHAPES = new Set(["none", "quiet", "lead", "lead-rest"]);

function cleanShape(shape) {
  const upcoming = Number(shape?.upcoming);
  return Number.isInteger(upcoming) && upcoming >= 0 && upcoming <= 5 && OUTLOOK_SHAPES.has(shape?.outlook)
    ? { outlook: shape.outlook, upcoming } : null;
}

export function readTrainPreviewShape(owner, scope) {
  try { return cleanShape(JSON.parse(localStorage.getItem(previewShapeKey(owner, scope)) || "null")); } catch { return null; }
}

export function rememberTrainPreviewShape(owner, scope, shape) {
  const clean = cleanShape(shape);
  if (!clean) return;
  try { localStorage.setItem(previewShapeKey(owner, scope), JSON.stringify(clean)); } catch { /* private mode */ }
}

const DEFAULT_PREVIEW_SHAPE = { outlook: "lead-rest", upcoming: 0 };

function skeletonOutlookHtml(shape) {
  const lead = '<span class="train-outlook-lead" aria-hidden="true"><b class="skeleton-text skeleton-number">00</b><span class="skeleton-text">due now</span></span>';
  if (shape === "none") return "";
  if (shape === "quiet") return '<span class="train-outlook-quiet skeleton-text" aria-hidden="true">Nothing due · next in 00 min</span>';
  return lead + (shape === "lead-rest" ? '<span class="train-outlook-rest skeleton-text" aria-hidden="true">0 this week</span>' : "");
}

export function paintTrainPreviewLoading(busy, shape = null) {
  const row = document.querySelector('#train-home [data-row="smart"]');
  const outlook = document.getElementById("train-outlook");
  const meta = document.getElementById("train-due-meta");
  const list = document.getElementById("train-due-next");
  row?.setAttribute("aria-busy", String(busy));
  outlook.setAttribute("aria-busy", String(busy));
  list.setAttribute("aria-busy", String(busy));
  if (!busy) return;
  const known = shape || DEFAULT_PREVIEW_SHAPE;
  outlook.innerHTML = skeletonOutlookHtml(known.outlook);
  outlook.hidden = known.outlook === "none";
  meta.innerHTML = '<span class="skeleton-text" aria-hidden="true">0 cards</span>';
  list.innerHTML = Array.from({ length: known.upcoming }, () => '<li aria-hidden="true"><button type="button" class="train-due-line" inert><span class="un-kind skeleton-text">New move</span><span class="train-due-rep"><span class="color-dot skeleton-dot"></span><span class="skeleton-text">Opening repertoire</span></span><span class="train-due-pos skeleton-text">1.e4 e5</span></button></li>').join("");
  list.hidden = !known.upcoming;
}
