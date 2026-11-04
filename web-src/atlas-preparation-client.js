const NODE_FIELDS = ["id", "parent_id", "fen", "uci", "is_enabled", "is_prepared", "is_mainline"];

export function startAtlasPreparation(input, { onResult, onError }) {
  let worker, active = true;
  const cancel = () => {
    if (!active) return;
    active = false;
    worker?.terminate();
  };
  const finish = (callback, value) => {
    if (!active) return;
    cancel();
    callback(value);
  };
  try {
    worker = new Worker(new URL("./atlas-preparation-worker.js", import.meta.url), { type: "module" });
    worker.onmessage = ({ data }) => {
      if (data.error !== undefined) finish(onError, new Error(data.error));
      else finish(onResult, data.result);
    };
    worker.onerror = (event) => finish(onError, new Error(event.message || "Atlas worker failed"));
    worker.onmessageerror = () => finish(onError, new Error("Atlas worker returned unreadable data"));
    worker.postMessage({
      nodes: (input.nodes || []).map((node) => Object.fromEntries(NODE_FIELDS.map((key) => [key, node[key]]))),
      myColor: input.myColor, rootNodeId: input.rootNodeId, horizon: input.horizon,
    });
  } catch (error) {
    finish(onError, error instanceof Error ? error : new Error(String(error)));
  }
  return cancel;
}
