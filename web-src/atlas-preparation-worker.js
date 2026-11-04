import { atlasPreparation } from "./atlas-quality.js";

self.onmessage = ({ data }) => {
  try {
    self.postMessage({ result: atlasPreparation(data) });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
