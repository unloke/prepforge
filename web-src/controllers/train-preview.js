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

export function paintTrainPreviewLoading(busy) {
  const row = document.querySelector('#train-home [data-row="smart"]');
  const outlook = document.getElementById("train-outlook");
  const meta = document.getElementById("train-due-meta");
  const list = document.getElementById("train-due-next");
  row?.setAttribute("aria-busy", String(busy));
  outlook.setAttribute("aria-busy", String(busy));
  list.setAttribute("aria-busy", String(busy));
  if (!busy) return;
  outlook.innerHTML = '<span class="train-outlook-lead skeleton-text"><b>0</b> due now</span><span class="train-outlook-rest skeleton-text">0 this week</span>';
  outlook.hidden = false;
  meta.innerHTML = '<span class="skeleton-text">0 cards</span>';
  list.innerHTML = Array.from({ length: 5 }, () => '<li aria-hidden="true"><button type="button" class="train-due-line" tabindex="-1" disabled><span class="un-kind skeleton-text">New move</span><span class="train-due-rep"><span class="color-dot skeleton-dot"></span><span class="skeleton-text">Opening repertoire</span></span><span class="train-due-pos skeleton-text">1.e4 e5</span></button></li>').join("");
  list.hidden = false;
}
