// Router model inference, mirroring train.py export(). Used by infer-bench.mjs and the
// Python/JS parity check in holdout.py.
//
//   node predict.mjs <model.json> <rows.json>   → JSON array of scores
import { readFileSync } from "node:fs";

const sigmoid = (z) => 1 / (1 + Math.exp(-z));
const scaled = (m, x) => (m.scaler ? x.map((v, i) => (v - m.scaler.mean[i]) / (m.scaler.scale[i] || 1)) : x);

export function predict(m, x) {
  if (m.kind === "logreg") {
    const z = scaled(m, x);
    let s = m.intercept;
    for (let i = 0; i < z.length; i++) s += m.coef[i] * z[i];
    return sigmoid(s);
  }
  if (m.kind === "tree") {
    let n = 0;
    while (m.left[n] !== -1) n = x[m.feature[n]] <= m.threshold[n] ? m.left[n] : m.right[n];
    return m.p[n];
  }
  if (m.kind === "gbt") {
    let s = m.baseline;
    for (const t of m.trees) {
      let n = 0;
      while (!t.leaf[n]) n = x[t.feature[n]] <= t.threshold[n] ? t.left[n] : t.right[n];
      s += t.value[n];
    }
    return sigmoid(s);
  }
  if (m.kind === "mlp") {
    let a = scaled(m, x);
    m.weights.forEach((w, l) => {
      const next = m.biases[l].slice();
      for (let i = 0; i < a.length; i++) for (let j = 0; j < next.length; j++) next[j] += a[i] * w[i][j];
      a = l < m.weights.length - 1 ? next.map((v) => Math.max(0, v)) : next.map(sigmoid);
    });
    return a[0];
  }
  throw new Error(m.kind);
}

if ((process.argv[1] || "").endsWith("predict.mjs")) {
  const [modelPath, rowsPath] = process.argv.slice(2);
  const model = JSON.parse(readFileSync(modelPath, "utf8"));
  console.log(JSON.stringify(JSON.parse(readFileSync(rowsPath, "utf8")).map((x) => predict(model, x))));
}
