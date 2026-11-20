import { describe, expect, it } from "vitest";
import { authRequestError } from "./auth-form.js";

describe("auth request rate limiting", () => {
  it("gives human guidance without a retry header", () => {
    expect(authRequestError({ status: 429, message: "Request failed (429)" })).toBe("Too many requests. Try again later.");
  });
  it("uses Retry-After seconds and HTTP dates", () => {
    expect(authRequestError({ status: 429, retryAfter: "60" })).toBe("Too many requests. Try again in 60 seconds.");
    expect(authRequestError({ status: 429, retryAfter: "Wed, 21 Oct 2015 07:28:00 GMT" }, Date.parse("2015-10-21T07:27:30Z"))).toBe("Too many requests. Try again in 30 seconds.");
  });
  it.each(["", "bad", "-1", "0", null])("handles absent or unusable Retry-After %s", (retryAfter) => {
    expect(authRequestError({ status: 429, retryAfter })).toBe("Too many requests. Try again later.");
  });
  it("preserves other errors and handles an empty error", () => {
    expect(authRequestError(new Error("Wrong password"))).toBe("Wrong password");
    expect(authRequestError(null)).toBe("Something went wrong.");
  });
});
