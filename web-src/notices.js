import { html, raw } from "./html.js";

// The app's one notification system. Every message, job card and undo window
// is a Notice in one stack: bottom-right on desktop, one card at a time at the
// top on phones (phone.css). Rules:
//   - tones: info / success / warning / error. Info and success leave after a
//     few seconds, warnings a little later; errors stay until dismissed or
//     resolved (a later status update with the same key replaces them).
//   - a notice with the same key as a visible one updates it in place, so a
//     repeated message never stacks.
//   - routine status lines share one slot (STATUS_KEY): a newer status replaces
//     the older one, and the slot is dropped when the user changes page.
//   - at most MAX_VISIBLE cards; the oldest finished card makes room.
export const STATUS_KEY = "status";
const MAX_VISIBLE = 4;
const DURATION = { info: 4000, success: 4000, warning: 7000, error: 0 };
const JOB_DONE_MS = 5000;
const JOB_CANCELLED_MS = 3000;
// In-progress lines ("Loading…") usually resolve within a moment; only show
// one if it is still current after this delay.
const PROGRESS_SHOW_DELAY = 700;
// A status raised by the action that is navigating survives that navigation.
const NAV_GRACE_MS = 400;
// Repaint progress at most this often: tight loops call update() hundreds of
// times back-to-back. Skipped ticks are stashed and flushed on the trailing edge.
const PROGRESS_RENDER_MS = 90;
const SWIPE_DISMISS_PX = 56;

export function createNotices() {
  return new Notices();
}

export function isProgressMessage(text) {
  return /(\.\.\.|…)$/.test(text);
}

export function shouldClearStatusOnNavigate(raisedAt, now, graceMs = NAV_GRACE_MS) {
  const at = Number(raisedAt) || 0;
  if (!at) return true;
  return now - at >= graceMs;
}

const ICONS = {
  success: '<path d="M4 8.5l2.5 2.5L12 5.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  warning: '<path d="M8 4.5v4.2M8 11.2v.3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  error: '<path d="M5.5 5.5l5 5M10.5 5.5l-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  info: '<circle cx="8" cy="8" r="2.2" fill="currentColor"/>',
};

class Notice {
  constructor(stack, opts = {}) {
    this.stack = stack;
    this.key = opts.key || null;
    this.job = !!opts.job;
    this.state = this.job ? "running" : "shown";
    this.tone = this.job ? "info" : toneOf(opts.tone);
    this.actions = Array.isArray(opts.actions) ? opts.actions : [];
    this.onCancel = typeof opts.onCancel === "function" ? opts.onCancel : null;
    this.onClose = null;
    this.onClick = null;
    this.cancelRequested = false;
    this.removed = false;
    this.raisedAt = Date.now();
    this.timer = null;
    this.remaining = 0;
    this.startedAt = 0;
    // Job progress.
    this.activeTotal = Math.max(1, Number(opts.total) || 1);
    this.lastDisplayedPercent = 0;
    this._phase = null;
    this._lastProgressRenderAt = 0;
    this._pendingMessage = null;
    this._progressFlushTimer = null;
    // `dock`: an in-page host (e.g. the Analyze panel) for a job whose card
    // would otherwise float over the very result it is producing.
    const dock = this.job && opts.dock && opts.dock.isConnected ? opts.dock : null;
    this.dock = dock;
    if (dock) {
      // A dock hosts one card and is not part of the stack: the report that
      // replaces a failed job's card would otherwise be evicted for the failed
      // card, and `active` would point at a card the user can't see.
      if (dock._notice) dock._notice.dismiss(true);
      dock._notice = this;
    }
    this._build(opts);
    if (dock) {
      this.el.classList.add("is-docked");
      dock.appendChild(this.el);
    } else {
      stack._add(this);
    }
    requestAnimationFrame(() => {
      requestAnimationFrame(() => this.el.classList.add("is-visible"));
    });
  }

  _build(opts) {
    const el = document.createElement("div");
    el.className = "notice";
    el._notice = this;
    this.el = el;
    const stop = this.onCancel ? html`<button class="notice-stop" type="button">Stop</button>` : "";
    const track = this.job ? html`<div class="notice-track"><div class="notice-fill"></div></div>` : "";
    el.innerHTML =
      html`<span class="notice-icon" aria-hidden="true"></span><div class="notice-main"><div class="notice-title"></div><div class="notice-text"></div>${track}</div><div class="notice-actions">${stop}</div><button class="btn ghost icon sm notice-close" type="button" aria-label="Dismiss" title="Dismiss"><svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button>`;
    this.iconEl = el.querySelector(".notice-icon");
    this.titleEl = el.querySelector(".notice-title");
    this.textEl = el.querySelector(".notice-text");
    this.fillEl = el.querySelector(".notice-fill");
    this.stopBtn = el.querySelector(".notice-stop");
    this.actionsEl = el.querySelector(".notice-actions");
    el.querySelector(".notice-close").addEventListener("click", (event) => {
      event.stopPropagation();
      this.dismiss();
    });
    if (this.stopBtn) {
      this.stopBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        this.requestCancel();
      });
    }
    this._renderActions();
    el.addEventListener("click", () => {
      if (this.state === "done" && this.onClick) {
        this.onClick();
        this.dismiss();
      }
    });
    el.addEventListener("pointerenter", () => this._pause());
    el.addEventListener("pointerleave", () => this._resume());
    this._bindSwipe(el);
    this._paint(opts.title || "", this.job ? opts.message || "Queued" : opts.message || "");
  }

  _renderActions() {
    this.actionsEl.querySelectorAll(".notice-action").forEach((b) => b.remove());
    this.actions.forEach((action) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `notice-action${action.primary ? " is-primary" : ""}`;
      btn.textContent = action.label || "OK";
      btn.addEventListener("click", (event) => {
        event.stopPropagation();
        if (typeof action.onClick === "function") action.onClick();
        if (action.closeOnClick !== false) this.dismiss();
      });
      this.actionsEl.appendChild(btn);
    });
  }

  _paint(title, message) {
    if (title !== undefined) {
      this.titleEl.textContent = title || "";
      this.titleEl.hidden = !title;
    }
    if (message !== undefined) {
      this.textEl.textContent = message || "";
      this.textEl.hidden = !message;
      this.el.title = message || "";
    }
    const el = this.el;
    el.dataset.tone = this.tone;
    el.dataset.state = this.state;
    el.classList.toggle("is-job", this.job);
    el.classList.toggle("has-actions", this.actions.length > 0 || !!this.stopBtn);
    // Running jobs are dismissed by Stop, not ×.
    el.classList.toggle("is-sticky", this.job && this.state === "running");
    const alert = this.tone === "error";
    el.setAttribute("role", alert ? "alert" : "status");
    el.setAttribute("aria-live", alert ? "assertive" : "polite");
    this.iconEl.innerHTML = this.job && this.state === "running"
      ? ""
      // eslint-disable-next-line local/trusted-raw -- ICONS is a constant table of SVG paths.
      : html`<svg width="16" height="16" viewBox="0 0 16 16">${raw(ICONS[this.tone])}</svg>`;
  }

  // Replace the content of a visible notice (same key) and restart its timer.
  replace(opts) {
    this.tone = toneOf(opts.tone);
    this.actions = Array.isArray(opts.actions) ? opts.actions : [];
    this.raisedAt = Date.now();
    this._renderActions();
    this._paint(opts.title || "", opts.message || "");
    this.el.classList.remove("is-bump");
    void this.el.offsetWidth;
    this.el.classList.add("is-bump");
  }

  // ---- Auto-dismiss: one timer, paused while the pointer is over the card.
  arm(ms, onClose = null) {
    this._clearTimer();
    if (onClose) this.onClose = onClose;
    this.remaining = ms;
    if (ms > 0) this._resume();
  }

  _pause() {
    if (!this.timer) return;
    this._clearTimer();
    this.remaining = Math.max(1200, this.remaining - (Date.now() - this.startedAt));
  }

  _resume() {
    if (this.timer || !this.remaining || this.removed) return;
    this.startedAt = Date.now();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.remaining = 0;
      this.dismiss();
    }, this.remaining);
  }

  _clearTimer() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  // Drag a card away (any direction) to dismiss it. Running jobs stay put.
  _bindSwipe(el) {
    let start = null;
    el.addEventListener("pointerdown", (event) => {
      if (event.pointerType === "mouse" || event.target.closest("button")) return;
      start = { x: event.clientX, y: event.clientY };
    });
    el.addEventListener("pointermove", (event) => {
      if (!start || el.classList.contains("is-sticky")) return;
      const dx = event.clientX - start.x;
      const dy = Math.min(0, event.clientY - start.y);
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      el.style.opacity = String(Math.max(0.2, 1 - Math.hypot(dx, dy) / 160));
    });
    const end = (event) => {
      if (!start) return;
      const dist = Math.hypot(event.clientX - start.x, Math.min(0, event.clientY - start.y));
      start = null;
      el.style.transform = "";
      el.style.opacity = "";
      if (dist > SWIPE_DISMISS_PX && !el.classList.contains("is-sticky")) this.dismiss(true);
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  }

  // ---- Jobs ----------------------------------------------------------------
  update({ current, total, message, phase }) {
    if (this.state !== "running") return;
    if (phase && phase !== this._phase) {
      // A new phase may have a smaller denominator: adopt it and restart the bar.
      this._phase = phase;
      if (total) this.activeTotal = Math.max(1, total);
      this.lastDisplayedPercent = 0;
      this._lastProgressRenderAt = 0;
    } else if (total && total > this.activeTotal) {
      this.activeTotal = total;
    }
    const ratio = Math.max(0, Math.min(1, (Number(current) || 0) / this.activeTotal));
    // Slightly pessimistic curve so the final segment feels fast.
    const display = Math.min(0.95, Math.pow(ratio, 1.5));
    if (display > this.lastDisplayedPercent) this.lastDisplayedPercent = display;
    if (this.fillEl) {
      this.fillEl.classList.toggle(
        "is-indeterminate",
        !(Number(current) > 0) && this.lastDisplayedPercent === 0,
      );
    }
    if (message) this._pendingMessage = message;
    const elapsed = Date.now() - this._lastProgressRenderAt;
    if (elapsed < PROGRESS_RENDER_MS) {
      if (!this._progressFlushTimer) {
        this._progressFlushTimer = setTimeout(() => this._flushProgress(), PROGRESS_RENDER_MS - elapsed);
      }
      return;
    }
    this._flushProgress();
  }

  _flushProgress() {
    this._clearProgressFlush();
    if (this.state !== "running") return;
    this._lastProgressRenderAt = Date.now();
    this._renderFill(this.lastDisplayedPercent);
    if (this._pendingMessage && !this.cancelRequested) this.textEl.textContent = this._pendingMessage;
  }

  _clearProgressFlush() {
    if (this._progressFlushTimer) {
      clearTimeout(this._progressFlushTimer);
      this._progressFlushTimer = null;
    }
  }

  requestCancel() {
    if (this.cancelRequested || !this.onCancel) return;
    this.cancelRequested = true;
    this.el.classList.add("is-cancelling");
    if (this.stopBtn) {
      this.stopBtn.disabled = true;
      this.stopBtn.textContent = "Stopping…";
    }
    try {
      this.onCancel();
    } catch (_) {
      /* best-effort */
    }
  }

  // Once a result is committed to a server save, Stop can no longer hold:
  // drop it, and adopt `message` as the stash so a pending flush can't stomp it.
  lockCancel(message) {
    this._clearProgressFlush();
    this._dropStop();
    if (message && !this.cancelRequested) {
      this._pendingMessage = message;
      this.textEl.textContent = message;
    }
  }

  _dropStop() {
    this.onCancel = null;
    if (this.stopBtn) {
      this.stopBtn.remove();
      this.stopBtn = null;
    }
  }

  _finish(state, tone, title, message) {
    this.state = state;
    this.tone = tone;
    this._clearProgressFlush();
    this._dropStop();
    this._paint(title, message);
    // A docked card lives next to the panel it reports on; a finish still ends
    // the job, so it leaves the dock instead of sitting there as "Job failed".
    if (this.dock) this.dismiss(true);
  }

  complete({ title, message, onClick } = {}) {
    this.onClick = typeof onClick === "function" ? onClick : null;
    this._finish("done", "success", title, message);
    this.lastDisplayedPercent = 1;
    this._renderFill(1);
    if (this.dock?.id === "analysis-job-dock") this.dismiss(true);
    else this.arm(JOB_DONE_MS);
  }

  fail(message) {
    this._finish("failed", "error", "Job failed", message || "Unknown error");
  }

  cancelled(message) {
    this._finish("cancelled", "info", "Stopped", message);
    this.arm(JOB_CANCELLED_MS);
  }

  _renderFill(ratio) {
    if (!this.fillEl) return;
    this.fillEl.style.width = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
    if (ratio > 0) this.fillEl.classList.remove("is-indeterminate");
  }

  dismiss(immediate = false) {
    if (this.removed) return;
    this.removed = true;
    this._clearProgressFlush();
    this._clearTimer();
    this.remaining = 0;
    // onClose runs however the card goes: timer, ×, swipe, eviction or action.
    const onClose = this.onClose;
    this.onClose = null;
    if (onClose) onClose();
    if (this.dock && this.dock._notice === this) this.dock._notice = null;
    this.stack._forget(this);
    if (immediate) {
      this.el.remove();
      return;
    }
    this.el.classList.remove("is-visible");
    this.el.classList.add("is-leaving");
    setTimeout(() => this.el.remove(), 220);
  }
}

function toneOf(tone) {
  return Object.hasOwn(DURATION, tone) ? tone : "info";
}

class Notices {
  constructor() {
    this.container = null;
    this.active = null;
    this.cards = [];
    this._statusShowTimer = null;
  }

  bind(container = document.getElementById("notices")) {
    this.container = container;
    // A finished card has said its piece: the next click elsewhere clears it,
    // so it never sits over the control the user reaches for next. Cards that
    // still offer something (actions, an error) stay.
    document.addEventListener(
      "pointerdown",
      (event) => {
        if (!this.container || this.container.contains(event.target)) return;
        for (const card of [...this.cards]) {
          if (card.actions.length || card.onClick || card.tone === "error" || card.state === "running") continue;
          if (card.job || card.raisedAt < Date.now() - 1500) card.dismiss();
        }
      },
      true,
    );
  }

  // A plain notice. `key` merges repeats; `duration` overrides the tone's
  // default (0 = stays until dismissed).
  show(message, { tone = "info", title, actions, key, duration, onClose } = {}) {
    if (!this.container) return null;
    const opts = { tone, title, message, actions };
    const k = key || `${toneOf(tone)}:${title || ""}:${message || ""}`;
    let card = this.cards.find((c) => c.key === k && !c.job);
    if (card) card.replace(opts);
    else card = new Notice(this, { ...opts, key: k });
    const ms = duration ?? (card.actions.length ? 0 : DURATION[card.tone]);
    card.arm(ms, onClose);
    return card;
  }

  // The routine status line: one slot, newest wins. Errors get their own card
  // (repeats merge) so a later routine line can't hide them. "" clears the
  // slot and resolves every status error.
  status(message, { tone = "info" } = {}) {
    clearTimeout(this._statusShowTimer);
    const text = String(message || "");
    if (!text) {
      this._statusCards().forEach((c) => c.dismiss());
      return;
    }
    if (tone === "error") {
      this.show(text, { tone, key: `${STATUS_KEY}:error:${text}` });
      return;
    }
    const show = () => this.show(text, { tone, key: STATUS_KEY });
    if (isProgressMessage(text)) {
      this.cards.find((c) => c.key === STATUS_KEY)?.dismiss();
      this._statusShowTimer = setTimeout(show, PROGRESS_SHOW_DELAY);
      return;
    }
    show();
  }

  // Status lines belong to the page they were raised on.
  clearStatusOnNavigate(now = Date.now()) {
    clearTimeout(this._statusShowTimer);
    for (const card of this._statusCards()) {
      if (shouldClearStatusOnNavigate(card.raisedAt, now)) card.dismiss();
    }
  }

  _statusCards() {
    return this.cards.filter((c) => c.key === STATUS_KEY || c.key?.startsWith(`${STATUS_KEY}:`));
  }

  statusText() {
    return this.cards.find((c) => c.key === STATUS_KEY)?.textEl.textContent || "";
  }

  isBusy() {
    return !!this.active && this.active.state === "running";
  }

  startJob(opts) {
    if (!this.container) return null;
    this.active = new Notice(this, { ...opts, job: true });
    return this.active;
  }

  updateJob(data) {
    this.active?.update(data);
  }

  completeJob(data) {
    this.active?.complete(data);
  }

  failJob(message) {
    this.active?.fail(message);
    this.active = null;
  }

  cancelJob(message) {
    this.active?.cancelled(message);
    this.active = null;
  }

  lockJob(message) {
    this.active?.lockCancel(message);
  }

  _add(card) {
    this.cards.push(card);
    this.container.appendChild(card.el);
    // Over the limit: the oldest plain card makes room, then the oldest
    // non-error card, then the oldest card that isn't a running job.
    while (this.cards.length > MAX_VISIBLE) {
      const idle = (c) => c.state !== "running";
      const victim =
        this.cards.find((c) => idle(c) && c.tone !== "error" && !c.actions.length) ||
        this.cards.find((c) => idle(c) && c.tone !== "error") ||
        this.cards.find(idle);
      if (!victim) break;
      victim.dismiss(true);
    }
  }

  _forget(card) {
    this.cards = this.cards.filter((c) => c !== card);
    if (this.active === card) this.active = null;
  }
}
