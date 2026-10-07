let escapeHtml;

export function createToastStack(deps) {
  ({ escapeHtml } = deps);
  return new ToastStack();
}

// Delays (ms) for auto-dismissing a card. The countdown pauses during pointer activity.
const TOAST_DONE_DELAY = 5000;
const TOAST_FAILED_DELAY = 6000;
const TOAST_CANCELLED_DELAY = 4500;
// Minimum gap between progress repaints. A tight loop (e.g. per-ply Brilliant checks, where
// most plies are ineligible and iterate with no awaits between them) can call update() hundreds
// of times back-to-back; repainting the bar + message every tick is wasted layout. We coalesce
// to ~one repaint per this interval. Skipped ticks lose nothing — percent/message are stashed
// and the next allowed tick (or the terminal complete/fail/cancel, which paint directly) shows
// the final state — so this is a pure throughput win with no effect on what the user ends up seeing.
const TOAST_PROGRESS_RENDER_MS = 90;
// How long the pointer must rest motionless over a card before its countdown
// is allowed to resume.
const TOAST_IDLE_RESUME_MS = 1100;

// A single notification card. Each job owns its own Toast (DOM + timers) so
// consecutive jobs never cross-talk; an old card's auto-dismiss can never
// reach into a newer card the way a shared, reused element used to.
//
// Two flavours share this one card system so they stack in a single column
// instead of overlapping:
//   - "job"  : a progress card with a Stop button (Analyze / Build gen).
//   - "info" : a notification with custom action buttons (e.g. "new game").
class Toast {
  constructor(stack, opts = {}) {
    const { title, total, variant, onCancel, message, actions } = opts;
    this.stack = stack;
    this.variant = variant === "info" ? "info" : "job";
    this.state = this.variant === "info" ? "info" : "running";
    this.minimized = false;
    this.activeTotal = Math.max(1, Number(total) || 1);
    this.lastDisplayedPercent = 0;
    // The named phase the bar is currently tracking (e.g. "stockfish" →
    // "maia-load" → "maia-inference" → "maia-traps" → "classify-save"). A job
    // that runs several phases with DIFFERENT scales resets the
    // denominator + bar when the phase label changes (see update()); null until the first
    // labelled tick.
    this._phase = null;
    // Progress-repaint coalescing (see update()): timestamp of the last DOM paint, the most
    // recent message we were asked to show but may have skipped painting, and a single
    // trailing-flush timer that guarantees the latest skipped state is eventually drawn.
    this._lastProgressRenderAt = 0;
    this._pendingMessage = null;
    this._progressFlushTimer = null;
    this.onClick = null;
    this.onCancel = typeof onCancel === "function" ? onCancel : null;
    this.cancelRequested = false;
    this.removed = false;
    // Single auto-action timer, gated by pointer activity.
    this.dismissTimer = null;
    this.dismissDelay = 0;
    this.dismissAction = null;
    this.idleTimer = null;
    this.hovering = false;
    this.pointerActive = false;
    // `dock`: an in-page host (e.g. the Analyze panel) for a job whose card would
    // otherwise float over the very result it is producing. A docked job is a panel
    // card, not a floating toast: one header row (title, live status, Stop) over a thin
    // progress track, and it never minimizes itself.
    const dock = opts.dock && opts.dock.isConnected ? opts.dock : null;
    this.dock = dock;
    this.el = this._build(title || "Working...", message, actions);
    this.el._toast = this;
    if (dock) {
      this.el.classList.add("is-docked");
      // One card per dock: a new job replaces the previous job's finished card.
      if (dock._jobToast) dock._jobToast.dismiss(true);
      dock._jobToast = this;
    }
    (dock || stack.container).appendChild(this.el);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => this.el.classList.add("is-visible"));
    });
  }

  _build(title, message, actions) {
    const el = document.createElement("div");
    el.className = `job-toast state-${this.state} variant-${this.variant}`;
    el.dataset.state = this.state;
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    el.setAttribute("aria-atomic", "true");
    const stopBtn = this.onCancel
      ? '<button class="job-toast-stop" type="button">Stop</button>'
      : "";
    if (this.variant === "job") {
      el.innerHTML =
        '<div class="job-toast-head">' +
        `<span class="job-toast-title">${escapeHtml(title)}</span>` +
        '<span class="job-toast-message">Queued</span>' +
        stopBtn +
        "</div>" +
        '<div class="job-toast-track"><div class="job-toast-fill"></div></div>';
    } else {
      el.innerHTML =
        '<div class="job-toast-head">' +
        '<span class="job-toast-icon" aria-hidden="true"></span>' +
        `<span class="job-toast-title">${escapeHtml(title)}</span>` +
        '<button class="job-toast-collapse" type="button" title="Minimize" aria-label="Minimize">_</button>' +
        "</div>" +
        '<div class="job-toast-body">' +
        `<div class="job-toast-message">${escapeHtml(message || "")}</div>` +
        '<div class="job-toast-actions"></div></div>';
    }
    this.titleEl = el.querySelector(".job-toast-title");
    this.messageEl = el.querySelector(".job-toast-message");
    this.fillEl = el.querySelector(".job-toast-fill");
    this.collapseBtn = el.querySelector(".job-toast-collapse");
    this.stopBtn = el.querySelector(".job-toast-stop");
    if (this.collapseBtn) {
      this.collapseBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        this.toggleMinimize(true);
      });
    }
    if (this.stopBtn) {
      this.stopBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        this.requestCancel();
      });
    }
    if (this.variant === "info" && Array.isArray(actions)) {
      const host = el.querySelector(".job-toast-actions");
      actions.forEach((action) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = `btn ${action.primary ? "primary" : "ghost"} toast-action`;
        btn.textContent = action.label || "OK";
        btn.addEventListener("click", (event) => {
          event.stopPropagation();
          if (typeof action.onClick === "function") action.onClick();
          if (action.closeOnClick !== false) this.dismiss();
        });
        host.appendChild(btn);
      });
    }
    el.addEventListener("click", () => {
      if (this.state === "done" && this.onClick) {
        this.onClick();
        this.dismiss();
      } else if (this.minimized) {
        this.toggleMinimize(false);
      }
    });
    this._bindHoverGating(el);
    return el;
  }

  update({ current, total, message, phase }) {
    if (this.state !== "running") return;
    if (phase && phase !== this._phase) {
      // Entering a new phase with its own scale: adopt its denominator — which may be SMALLER
      // than the previous phase's (e.g. 48 positions → 47 moves) — and restart the bar. The
      // monotonic "activeTotal only grows / percent only climbs" rule below is right WITHIN a
      // phase, but across phases it pinned a smaller-denominator phase near the 95% cap, so the
      // job looked frozen at "47/48". A phase change is the one place both may move backward.
      this._phase = phase;
      if (total) this.activeTotal = Math.max(1, total);
      this.lastDisplayedPercent = 0;
      this._lastProgressRenderAt = 0;
    } else if (total && total > this.activeTotal) {
      this.activeTotal = total;
    }
    const ratio = Math.max(0, Math.min(1, (Number(current) || 0) / this.activeTotal));
    // Slightly pessimistic curve so the final segment feels fast.
    const pessimistic = Math.pow(ratio, 1.5);
    const display = Math.min(0.95, pessimistic);
    if (display > this.lastDisplayedPercent) this.lastDisplayedPercent = display;
    if (this.fillEl) {
      const hasRealProgress = (Number(current) || 0) > 0;
      this.fillEl.classList.toggle(
        "is-indeterminate",
        !hasRealProgress && this.lastDisplayedPercent === 0,
      );
    }
    if (message) this._pendingMessage = message;
    // Coalesce rapid ticks: repaint at most once per TOAST_PROGRESS_RENDER_MS. A tick inside
    // the window doesn't paint NOW, but it arms a single trailing flush for the end of the
    // window — so the latest stashed percent/message is GUARANTEED to be drawn even if no
    // further tick (and no terminal complete/fail/cancel) ever arrives. No skipped state is lost.
    const now = Date.now();
    const elapsed = now - this._lastProgressRenderAt;
    if (elapsed < TOAST_PROGRESS_RENDER_MS) {
      if (!this._progressFlushTimer) {
        this._progressFlushTimer = setTimeout(
          () => this._flushProgress(),
          TOAST_PROGRESS_RENDER_MS - elapsed,
        );
      }
      return;
    }
    this._flushProgress();
  }

  // Paint the latest stashed progress (bar + message). Cancels any pending trailing flush so
  // the leading and trailing edges never double-paint. No-op once the job has left "running":
  // the terminal states (complete/fail/cancelled) paint their own final frame, and a late
  // trailing flush must not stomp it back to ~95% / a stale message.
  _flushProgress() {
    this._clearProgressFlush();
    if (this.state !== "running") return;
    this._lastProgressRenderAt = Date.now();
    this._renderFill(this.lastDisplayedPercent);
    if (this._pendingMessage && !this.cancelRequested) {
      this.messageEl.textContent = this._pendingMessage;
    }
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
      this.stopBtn.textContent = "Stopping...";
    }
    if (this.messageEl) this.messageEl.textContent = "Stopping job...";
    try {
      this.onCancel();
    } catch (_) {
      /* best-effort */
    }
  }

  // Make the job non-cancellable from here on and remove the Stop affordance.
  // Used once a result is committed to a server save: aborting the fetch can't
  // un-persist an atomic apply, so the UI must stop implying a cancel that
  // wouldn't hold. No-op if the user already requested cancel.
  //
  // The job stays "running" through the save phase, so the _flushProgress state-guard does
  // NOT protect this message: a trailing flush armed by a throttled progress tick just before
  // the lock would otherwise fire ~90ms later and stomp the lock text back to the stale
  // progress message. Cancel that pending flush AND adopt the lock message as the new stash,
  // so neither the pending flush nor any later one can overwrite it.
  lockCancel(message) {
    this._clearProgressFlush();
    this._dropStop();
    if (message && this.messageEl && !this.cancelRequested) {
      this._pendingMessage = message;
      this.messageEl.textContent = message;
    }
  }

  // Remove the Stop affordance and detach the cancel handler. Used both by the
  // saving-phase lock and by every terminal state below: once a job is done/failed/
  // stopped, cancellation has no meaning, so the finished card must not keep a Stop
  // button that visually implies it can still be cancelled.
  _dropStop() {
    this.onCancel = null;
    if (this.stopBtn) {
      this.stopBtn.remove();
      this.stopBtn = null;
    }
  }

  complete({ title, message, onClick } = {}) {
    this.state = "done";
    this.minimized = false;
    this._clearProgressFlush();
    this._dropStop();
    this.onClick = typeof onClick === "function" ? onClick : null;
    this._applyState();
    if (title) this.titleEl.textContent = title;
    if (message) this.messageEl.textContent = message;
    this.lastDisplayedPercent = 1;
    this._renderFill(1);
    if (this.dock?.id === "analysis-job-dock") this.dismiss(true);
    else this._arm(TOAST_DONE_DELAY, () => this.dismiss());
  }

  fail(message) {
    this.state = "failed";
    this._clearProgressFlush();
    this._dropStop();
    this._applyState();
    this.titleEl.textContent = "Job failed";
    this.messageEl.textContent = message || "Unknown error";
    this._arm(TOAST_FAILED_DELAY, () => this.dismiss());
  }

  // A job the user stopped: acknowledge briefly, then fade out.
  cancelled(message) {
    this.state = "cancelled";
    this.minimized = false;
    this._clearProgressFlush();
    this._dropStop();
    this._applyState();
    this.titleEl.textContent = "Stopped";
    if (message) this.messageEl.textContent = message;
    this._renderFill(this.lastDisplayedPercent);
    this._arm(TOAST_CANCELLED_DELAY, () => this.dismiss());
  }

  toggleMinimize(force) {
    if (this.variant === "job") return;
    const next = typeof force === "boolean" ? force : !this.minimized;
    this.minimized = next;
    this.el.classList.toggle("is-minimized", next);
  }

  dismiss(immediate = false) {
    if (this.removed) return;
    this.removed = true;
    this._clearProgressFlush();
    this._clearDismiss();
    this._clearIdle();
    if (this.dock && this.dock._jobToast === this) this.dock._jobToast = null;
    if (immediate) {
      this.el.remove();
      this.stack._forget(this);
      return;
    }
    // Collapse out: slide away + shrink height so the cards below rise smoothly.
    this.el.classList.remove("is-visible");
    this.el.classList.add("is-leaving");
    setTimeout(() => {
      this.el.remove();
      this.stack._forget(this);
    }, 300);
  }

  _applyState() {
    this.el.dataset.state = this.state;
    this.el.classList.remove(
      "state-running",
      "state-done",
      "state-failed",
      "state-cancelled",
      "state-info"
    );
    this.el.classList.add(`state-${this.state}`);
    this.el.classList.toggle("is-minimized", this.minimized);
    const failed = this.state === "failed";
    this.el.setAttribute("role", failed ? "alert" : "status");
    this.el.setAttribute("aria-live", failed ? "assertive" : "polite");
  }

  _renderFill(ratio) {
    if (!this.fillEl) return;
    this.fillEl.style.width = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
    if (ratio > 0) this.fillEl.classList.remove("is-indeterminate");
  }

  // ---- Pointer-gated auto-dismiss --------------------------------------
  // Arms a single deferred action (minimize or dismiss). The countdown is
  // suspended while the pointer is actively moving over the card and only
  // (re)starts once the pointer leaves or goes still — so a card never
  // collapses out from under a user who is reading or reaching for it.
  _arm(delay, action) {
    this.dismissDelay = delay;
    this.dismissAction = action;
    this._evaluateDismiss();
  }

  _evaluateDismiss() {
    if (!this.dismissAction) return;
    const hold = this.hovering && this.pointerActive;
    if (hold) {
      this._clearDismiss();
      return;
    }
    if (this.dismissTimer) return; // already counting
    this.dismissTimer = setTimeout(() => {
      this.dismissTimer = null;
      const action = this.dismissAction;
      this.dismissAction = null;
      if (action) action();
    }, this.dismissDelay);
  }

  _clearDismiss() {
    if (this.dismissTimer) {
      clearTimeout(this.dismissTimer);
      this.dismissTimer = null;
    }
  }

  _clearIdle() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  _bindHoverGating(el) {
    el.addEventListener("pointerenter", () => {
      this.hovering = true;
      this.pointerActive = true;
      this._evaluateDismiss();
    });
    el.addEventListener("pointermove", () => {
      if (!this.hovering) this.hovering = true;
      this.pointerActive = true;
      this._clearIdle();
      this._evaluateDismiss();
      // Resume the countdown once the pointer rests motionless for a moment.
      this.idleTimer = setTimeout(() => {
        this.idleTimer = null;
        this.pointerActive = false;
        this._evaluateDismiss();
      }, TOAST_IDLE_RESUME_MS);
    });
    el.addEventListener("pointerleave", () => {
      this.hovering = false;
      this.pointerActive = false;
      this._clearIdle();
      this._evaluateDismiss();
    });
  }
}

// Manages a vertical stack of independent Toasts. Heavy jobs are sequential
// (the server runs one at a time), so the manager tracks the current job as
// `active` for update/complete/fail/cancel, but every card — including info
// notifications — lives and dies on its own.
class ToastStack {
  constructor() {
    this.container = null;
    this.active = null;
  }

  bind() {
    this.container = document.getElementById("toast-stack");
    // A finished job's card has said its piece: the next click anywhere else
    // clears it, so it never sits over the control the user reaches for next.
    document.addEventListener(
      "pointerdown",
      (event) => {
        if (!this.container || this.container.contains(event.target)) return;
        this.container
          .querySelectorAll(".job-toast.state-done, .job-toast.state-failed, .job-toast.state-cancelled")
          .forEach((el) => {
            // Cards that still offer something (open result, Retry) stay until their timer.
            if (el._toast && !el._toast.onClick && !el.querySelector(".toast-action")) el._toast.dismiss();
          });
      },
      true,
    );
  }

  isBusy() {
    return !!this.active && this.active.state === "running";
  }

  startJob(opts) {
    if (!this.container) return null;
    this.active = new Toast(this, opts);
    return this.active;
  }

  // Standalone notification card (shares the stack so nothing overlaps).
  notify(opts) {
    if (!this.container) return null;
    return new Toast(this, { ...opts, variant: "info" });
  }

  updateJob(data) {
    if (this.active) this.active.update(data);
  }

  completeJob(data) {
    if (this.active) this.active.complete(data);
  }

  failJob(message) {
    if (this.active) this.active.fail(message);
  }

  cancelJob(message) {
    if (this.active) this.active.cancelled(message);
  }

  // Disable cancellation on the active job (remove its Stop button).
  lockJob(message) {
    if (this.active) this.active.lockCancel(message);
  }

  _forget(toast) {
    if (this.active === toast) this.active = null;
  }
}
