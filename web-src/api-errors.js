// FastAPI validation failures carry a list of { loc, msg } entries. Keep the
// field and explanation in the UI; callers still receive the original detail
// object on the Error for recovery flows such as revision conflicts.
export function apiErrorMessage(status, detail) {
  if (typeof detail === "string" && detail.trim()) return detail;
  if (detail && typeof detail.message === "string" && detail.message.trim()) return detail.message;
  if (Array.isArray(detail)) {
    const messages = detail.flatMap((entry) => {
      if (!entry || typeof entry.msg !== "string" || !entry.msg.trim()) return [];
      const path = Array.isArray(entry.loc)
        ? entry.loc.filter((part) => !["body", "query", "path", "header", "cookie"].includes(part)).join(".")
        : "";
      const field = path.replace(/_/g, " ").replace(/^./, (letter) => letter.toUpperCase());
      const message = entry.msg.trim()
        .replace(/^value error,\s*/i, "")
        .replace(/^value is not a valid email address:\s*/i, "Enter a valid email address. ");
      return [field ? `${field}: ${message}` : message];
    });
    if (messages.length) return [...new Set(messages)].join(" ");
  }
  return `Request failed (${status})`;
}
