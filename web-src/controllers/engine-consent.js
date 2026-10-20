import { html } from "../html.js";

// The full net is 94 MB, so the engine card asks before fetching it. The
// question is one row above the card's lines: the lite search keeps running and
// painting underneath it, and answering never interrupts that search.
export function engineConsentHtml() {
  return html`<div class="engine-consent" data-testid="engine-full-choice">
    <span>Download the full engine?</span>
    <span class="engine-consent-actions">
      <button type="button" class="btn sm primary" data-choice="yes">Download (94 MB)</button>
      <button type="button" class="btn sm ghost" data-choice="no">Keep lite</button>
    </span>
  </div>`;
}
