import { withRequestDeadline } from "./sync-queue.js";
import { describe, expect, it, vi } from "vitest";
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
  function responseAdapter(response, scheduler = {}) {
    const yieldStart = source.indexOf("async function yieldToBrowser(");
    const yieldEnd = source.indexOf("\n}\n", yieldStart) + 2;
    return new Function("fetch", "headersWithCsrf", "getCsrfToken", "isSessionAuthFailure",
      "AUTH_REQUIRED_MESSAGE", "apiErrorMessage", "withRequestDeadline", "CLIENT_ID_HEADER", "OUTBOX_TAB_ID", "globalThis",
      `${source.slice(yieldStart, yieldEnd)}; return (${source.slice(start, end)});`)(
      async () => response,
      async (_method, headers) => headers, () => "csrf", isSessionAuthFailure, AUTH_REQUIRED_MESSAGE, apiErrorMessage, withRequestDeadline,
      "X-PF-Client", "tab", { scheduler },
    );
  }
  function adapter(status, detail) {
    return responseAdapter(new Response(JSON.stringify({ detail }), { status, headers: { "retry-after": "4" } }));
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
  const largeJsonOptions = { responseType: "large-json" };
  const largeBody = { note: "é".repeat(600_000) };
  it("yields before and after parsing a large body by decoded byte size", async () => {
    const yieldTask = vi.fn(async () => {});
    const read = responseAdapter(new Response(JSON.stringify(largeBody)), { yield: yieldTask });
    await expect(read("/api/build/load", largeJsonOptions)).resolves.toEqual(largeBody);
    expect(yieldTask).toHaveBeenCalledTimes(2);
  });
  it("does not yield for small repertoire responses or lose HTTP errors", async () => {
    const scheduler = { yield: vi.fn() };
    const response = new Response('{"nodes":[]}', { headers: { "content-length": "12" } });
    const blob = vi.spyOn(response, "blob");
    const read = responseAdapter(response, scheduler);
    await expect(read("/api/build/load", largeJsonOptions)).resolves.toEqual({ nodes: [] });
    expect(blob).not.toHaveBeenCalled();
    const fail = responseAdapter(new Response("proxy offline", { status: 502 }), scheduler);
    await expect(fail("/api/build/load", largeJsonOptions)).rejects.toMatchObject({ status: 502 });
    expect(scheduler.yield).not.toHaveBeenCalled();
  });
  it("still yields when a small compressed transfer contains a large Unicode body", async () => {
    const yieldTask = vi.fn(async () => {});
    const response = new Response(JSON.stringify(largeBody), { headers: { "content-length": "1062", "content-encoding": "gzip" } });
    const read = responseAdapter(response, { yield: yieldTask });
    await expect(read("/api/build/load", largeJsonOptions)).resolves.toEqual(largeBody);
    expect(yieldTask).toHaveBeenCalledTimes(2);
  });
  it("does not deliver a parsed payload if canceled while yielding", async () => {
    const controller = new AbortController();
    const yieldTask = vi.fn(async () => {});
    const canceled = new Error("Superseded");
    yieldTask.mockImplementationOnce(async () => {}).mockImplementationOnce(async () => controller.abort(canceled));
    const read = responseAdapter(new Response(JSON.stringify(largeBody)), { yield: yieldTask });
    await expect(read("/api/build/load", { ...largeJsonOptions, signal: controller.signal })).rejects.toBe(canceled);
    expect(yieldTask).toHaveBeenCalledTimes(2);
  });
});
