const PREVIEW_TTL = 30000;

export function createTrainPreview(api) {
  let data = null;
  let dataKey = "";
  let requestedKey = "";
  let at = 0;
  let pending = null;
  let errorKey = "";

  return {
    dataFor: (key) => dataKey === key ? data : null,
    failed: (key) => errorKey === key,
    current: (key) => requestedKey === key,
    invalidate() {
      data = null;
      dataKey = "";
      at = 0;
      errorKey = "";
      pending = null;
      requestedKey = "";
    },
    load(key) {
      requestedKey = key;
      errorKey = "";
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
        if (pending === request && error?.status !== 401) {
          errorKey = key;
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
    el.setAttribute("aria-hidden", "true");
    el.setAttribute("tabindex", "-1");
    return;
  }
  if (!el.classList.contains("skeleton-control")) return;
  el.classList.remove("skeleton-control");
  el.removeAttribute("aria-hidden");
  el.removeAttribute("tabindex");
}

// Train Home's first paint is one coherent loading surface: stable chrome
// stays real, while every control whose label or availability depends on the
// repertoire listing is inert and masked in place. A later refresh over real
// content never uses this state; it keeps the content and marks only the row
// being refreshed busy.
export function paintTrainHomeLoading(busy) {
  const home = document.getElementById("train-home");
  if (!home) return;
  home.classList.toggle("is-loading", busy);
  if (busy) home.setAttribute("aria-busy", "true");
  else home.removeAttribute("aria-busy");
  for (const id of HOME_CONTROL_IDS) skeletonControl(document.getElementById(id), busy);
  for (const bot of document.querySelectorAll?.("#train-bots .train-bot") || []) skeletonControl(bot, busy);
}

export function paintTrainPreviewLoading(busy) {
  const row = document.querySelector('#train-home [data-row="smart"]');
  const outlook = document.getElementById("train-outlook");
  const meta = document.getElementById("train-due-meta");
  const list = document.getElementById("train-due-next");
  row?.setAttribute("aria-busy", String(busy));
  outlook.setAttribute("aria-busy", String(busy));
  list.setAttribute("aria-busy", String(busy));
  if (!busy) return;
  outlook.innerHTML = '<span class="train-outlook-lead" aria-hidden="true"><b class="skeleton-text skeleton-number">00</b><span class="skeleton-text">due now</span></span><span class="train-outlook-rest skeleton-text" aria-hidden="true">0 this week</span>';
  outlook.hidden = false;
  meta.innerHTML = '<span class="skeleton-text" aria-hidden="true">0 cards</span>';
  // Upcoming cards are optional content. Without a stored shape, fabricating
  // five rows only guarantees a large wrong layout when the real count lands.
  list.innerHTML = "";
  list.hidden = true;
}
