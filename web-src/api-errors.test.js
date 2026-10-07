import { withRequestDeadline } from "./sync-queue.js";
import { describe, expect, it } from "vitest";
import { apiErrorMessage } from "./api-errors.js";
import { AUTH_REQUIRED_MESSAGE, isSessionAuthFailure } from "./auth-gate.js";
import { appSource } from "./test-app-source.js";

const EMAIL_DETAIL = [{
  type: "value_error", loc: ["body", "email"],
  msg: "value is not a valid email address: The part after the @-sign is not valid. It should have a period.",
  input: "x@y", ctx: { reason: "The part after the @-sign is not valid." },
}];

describe("API error messages", () => {
  it("keeps the field and cause of EmailStr validation without echoing the input", () => {
    const message = apiErrorMessage(422, EMAIL_DETAIL);
    expect(message).toBe("Email: Enter a valid email address. The part after the @-sign is not valid. It should have a period.");
    expect(message).not.toContain("x@y");
  });
  it("supports other fields, multiple failures and malformed entries", () => {
    expect(apiErrorMessage(422, [null, {}, { loc: ["body", "display_name"], msg: "Value error, Choose a name." },
      { loc: ["query", "limit"], msg: "Input should be greater than 0" }])).toBe(
      "Display name: Choose a name. Limit: Input should be greater than 0",
    );
    expect(apiErrorMessage(422, [{ input: "secret" }])).toBe("Request failed (422)");
    expect(apiErrorMessage(500, null)).toBe("Request failed (500)");
  });
  it("keeps string and structured conflict messages", () => {
    expect(apiErrorMessage(401, "invalid email or password")).toBe("invalid email or password");
    expect(apiErrorMessage(409, { message: "Repertoire changed", current_revision: 3 })).toBe("Repertoire changed");
  });
});

// Run the real shared adapter as well: both messages and recovery metadata
// must survive the boundary to the auth modal / sync callers.
describe("shared API adapter", () => {
  const source = appSource();
  const start = source.indexOf("async function api(path, options = {}) {");
  const end = source.indexOf("\n}\n", start) + 2;
  function adapter(status, detail) {
    return new Function("fetch", "headersWithCsrf", "getCsrfToken", "isSessionAuthFailure",
      "AUTH_REQUIRED_MESSAGE", "apiErrorMessage", "withRequestDeadline", `return (${source.slice(start, end)});`)(
      async () => new Response(JSON.stringify({ detail }), { status, headers: { "retry-after": "4" } }),
      async (_method, headers) => headers, () => "csrf", isSessionAuthFailure, AUTH_REQUIRED_MESSAGE, apiErrorMessage, withRequestDeadline,
    );
  }
  it("exposes the validation explanation and preserves status/detail", async () => {
    await expect(adapter(422, EMAIL_DETAIL)("/api/auth/register")).rejects.toMatchObject({
      message: apiErrorMessage(422, EMAIL_DETAIL), status: 422, detail: EMAIL_DETAIL, retryAfter: "4",
    });
  });
  it("retains session-401 routing and wrong-password wording", async () => {
    await expect(adapter(401, "not authenticated")("/api/repertoires")).rejects.toMatchObject({
      message: AUTH_REQUIRED_MESSAGE, authRequired: true, status: 401,
    });
    await expect(adapter(401, "invalid email or password")("/api/auth/login")).rejects.toMatchObject({
      message: "invalid email or password", status: 401,
    });
  });
});
