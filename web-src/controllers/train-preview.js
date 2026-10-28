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
      }).catch(() => {
        if (pending === request) {
          errorKey = key;
          at = 0;
        }
        return null;
      }).finally(() => { if (pending === request) pending = null; });
      return request.promise;
    },
  };
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
  outlook.innerHTML = '<span class="skeleton-bar train-skeleton-outlook" aria-hidden="true"></span>';
  outlook.hidden = false;
  meta.innerHTML = '<span class="skeleton-bar train-skeleton-meta" aria-hidden="true"></span>';
  list.innerHTML = Array.from({ length: 3 }, () => '<li class="train-skeleton-line" aria-hidden="true"><span class="skeleton-bar train-skeleton-kind"></span><span class="skeleton-bar train-skeleton-rep"></span><span class="skeleton-bar train-skeleton-pos"></span></li>').join("");
  list.hidden = false;
}
