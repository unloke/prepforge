import { postJson, setStatus } from "./core/api.js";
import { showInputModal } from "./core/modals.js";

export function promptRenameRepertoire({ repertoireId, name, afterSave }) {
  return showInputModal({
    title: "Rename repertoire", okLabel: "Save",
    fields: [{ name: "name", label: "New name", default: name }],
    onSubmit: async (values, close) => {
      const next = (values.name || "").trim();
      if (!next) throw new Error("Enter a name.");
      const payload = await postJson("/api/build/rename", { repertoire_id: repertoireId, name: next });
      await afterSave(payload);
      close(values);
      setStatus(`Renamed to ${next}`);
    },
  });
}
