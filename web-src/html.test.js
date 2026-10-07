import { describe, expect, it } from "vitest";
import { html, raw } from "./html.js";

describe("html", () => {
  it("escapes text and quoted attributes, including injection payloads", () => {
    const value = `&<>"'`;
    expect(String(html`<b title="${value}">${value}</b>`)).toBe('<b title="&amp;&lt;&gt;&quot;&#39;">&amp;&lt;&gt;&quot;&#39;</b>');
    expect(String(html`<i>${'<img src=x onerror=alert(1)>'}</i>`)).toBe('<i>&lt;img src=x onerror=alert(1)&gt;</i>');
  });
  it("joins arrays recursively and only passes explicitly trusted fragments", () => {
    expect(String(html`${["<b>", [null, undefined, 0, false], html`<i>${"<&"}</i>`]}`)).toBe('&lt;b&gt;0false<i>&lt;&amp;</i>');
    expect(String(html`${html`<b>${"x"}</b>`}`)).toBe("<b>x</b>");
    expect(String(html`${String(html`<b>x</b>`)}`)).toBe("&lt;b&gt;x&lt;/b&gt;");
    expect(String(html`${{ value: "<b>x</b>" }}`)).toBe("[object Object]");
    expect(String(html`${raw("<br>")}`)).toBe("<br>");
  });
});
