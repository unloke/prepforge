import { describe, expect, it } from "vitest";
import { oauthErrorFromUrl } from "./oauth-errors.js";

describe("OAuth failure URLs", () => {
  it("recognizes only fixed provider error codes and removes the marker", () => {
    expect(oauthErrorFromUrl("https://example.test/?oauth_error=google_provider_error")).toEqual({
      code: "google_provider_error",
      provider: "google",
      message: "Google sign-in failed. Try again.",
      cleanHref: "/",
    });
    expect(oauthErrorFromUrl("/?oauth_error=lichess_account_taken#/settings")).toEqual({
      code: "lichess_account_taken",
      provider: "lichess",
      message: "That Lichess account is already linked to another user.",
      cleanHref: "/#/settings",
    });
  });

  it("ignores raw text, unknown codes, and missing markers", () => {
    expect(oauthErrorFromUrl("/?oauth_error=<script>alert(1)</script>")).toBeNull();
    expect(oauthErrorFromUrl("/?error=access_denied")).toBeNull();
    expect(oauthErrorFromUrl("/")).toBeNull();
  });
});
