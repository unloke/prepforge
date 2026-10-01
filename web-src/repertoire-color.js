// The side a repertoire is built for decides its training orientation, so the
// create/import dialogs offer exactly two choices instead of free text (where
// "b", "Black." or "黑" silently became White).
export function repertoireColorField(defaultColor = "white") {
  return {
    name: "color",
    label: "Your color",
    type: "select",
    default: normalizeRepertoireColor(defaultColor),
    options: [
      { value: "white", label: "White" },
      { value: "black", label: "Black" },
    ],
  };
}

export function normalizeRepertoireColor(value) {
  return String(value || "").trim().toLowerCase() === "black" ? "black" : "white";
}
