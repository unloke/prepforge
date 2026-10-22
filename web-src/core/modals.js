import { html } from "../html.js";
import { modalDialog, openModal } from "./dialog.js";

export function showInputModal({ title, fields, okLabel = "OK", onInput = null, onSubmit = null, cancel = true, dismissOnSubmit = false }) {
  return new Promise((resolve) => {
    const overlay = modalDialog();
    const fieldHtml = (field) => {
        const safeName = field.name;
        const safeLabel = field.label || field.name;
        const safeValue = field.default == null ? "" : String(field.default);
        if (field.type === "stat") {
          // A live number the caller re-writes on input. Bigger than a note so
          // the one figure that drives the decision is the dialog's focal point.
          return html`<div class="modal-stat" data-note="${safeName}"><b>${safeLabel}</b><span>${field.unit || ""}</span></div>`;
        }
        if (field.type === "note") {
          // Read-only informational line (no input, never collected).
          return html`<p class="modal-note muted" data-note="${safeName}">${safeLabel}</p>`;
        }
        if (field.type === "textarea") {
          return html`
            <label class="modal-field">
              <span>${safeLabel}</span>
              <textarea name="${safeName}" data-field>${safeValue}</textarea>
            </label>
          `;
        }
        if (field.type === "select") {
          const options = (field.options || [])
            .map((opt) => {
              const value = typeof opt === "string" ? opt : opt.value;
              const label = typeof opt === "string" ? opt : (opt.label || opt.value);
              const selected = String(field.default || "") === String(value) ? " selected" : "";
              return html`<option value="${value}"${selected}>${label}</option>`;
            });
          return html`
            <label class="modal-field">
              <span>${safeLabel}</span>
              <select name="${safeName}" data-field>${options}</select>
            </label>
          `;
        }
        const inputType = field.type === "number" ? "number" : "text";
        const numericAttrs =
          field.type === "number"
            ? html` min="${field.min ?? ""}" max="${field.max ?? ""}" step="${field.step ?? 1}"`
            : "";
        const hint = field.hint ? html` title="${field.hint}"` : "";
        return html`
          <label class="modal-field${field.type === "number" ? " is-num" : ""}"${hint}>
            <span>${safeLabel}</span>
            <input name="${safeName}" type="${inputType}" value="${safeValue}"${numericAttrs} data-field />
          </label>
        `;
    };
    // A group heading before each named run of fields; a field with no `group`
    // (or a repeated one) starts a new run, so callers only set the name.
    const inputsHtml = [];
    let lastGroup;
    for (const field of fields) {
      if (field.group && field.group !== lastGroup) {
        inputsHtml.push(html`<div class="modal-group-label">${field.group}</div>`);
      }
      lastGroup = field.group || "";
      inputsHtml.push(fieldHtml(field));
    }
    overlay.innerHTML = html`
      <h2 class="modal-title">${title}</h2>
      <div class="modal-body">${inputsHtml}</div>
      <div class="modal-footer">
        ${cancel ? html`<button class="btn ghost" data-action="cancel" type="button">Cancel</button>` : ""}
        <button class="btn primary" data-action="ok" type="button">${okLabel}</button>
      </div>
    `;
    const firstInput = overlay.querySelector("[data-field]");
    const cleanup = openModal(overlay, { initialFocus: firstInput, onDismiss: () => close(null) });
    firstInput?.select?.();
    let closed = false;
    const close = (values) => {
      if (closed) return;
      closed = true;
      cleanup();
      resolve(values);
    };
    // A caller that opens its own optimistic view dismisses the form on submit:
    // the promise still resolves when the caller closes it with the request's
    // outcome, but the overlay is gone immediately.
    let dismissed = false;
    const dismiss = () => {
      if (dismissed) return;
      dismissed = true;
      cleanup();
    };
    const collect = () => {
      const values = {};
      overlay.querySelectorAll("[data-field]").forEach((el) => {
        values[el.name] = el.value;
      });
      return values;
    };
    // Submitting hands the dialog a promise the caller keeps pending while its
    // request is in flight. Callers that don't (plain data entry) close on
    // submit, exactly as before. One request per dialog: Enter (or a double
    // click) while onSubmit is still running must not start a second one.
    let submitting = false;
    const submit = () => {
      if (submitting) return;
      const values = collect();
      if (typeof onSubmit !== "function") {
        close(values);
        return;
      }
      submitting = true;
      const okBtn = overlay.querySelector('[data-action="ok"]');
      const controls = [...overlay.querySelectorAll(".modal-footer .btn, [data-field]")];
      okBtn.classList.add("is-loading");
      okBtn.disabled = true;
      for (const el of controls) if (el !== okBtn) el.disabled = true;
      overlay.setAttribute("aria-busy", "true");
      let settled = false;
      // Silence/`controls` capture lets a failed submit re-enable the form
      // unless the caller closed the dialog (success) or submitted again.
      const idle = () => {
        submitting = false;
        if (settled) return;
        okBtn.classList.remove("is-loading");
        for (const el of controls) el.disabled = false;
        overlay.setAttribute("aria-busy", "false");
      };
      const finish = (fn) => (result) => {
        settled = true;
        fn(result);
      };
      if (dismissOnSubmit) dismiss();
      Promise.resolve()
        .then(() => onSubmit(values, finish(close)))
        .catch(() => { if (dismissOnSubmit && !closed) close(null); })
        .then(idle);
    };
    overlay.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && event.target.tagName !== "TEXTAREA" && event.target.tagName !== "BUTTON") {
        event.preventDefault();
        submit();
      }
    });
    overlay.querySelector('[data-action="cancel"]')?.addEventListener("click", () => close(null));
    overlay.querySelector('[data-action="ok"]').addEventListener("click", () => submit());
    if (typeof onInput === "function") {
      const fire = () => {
        try {
          onInput(collect(), overlay);
        } catch (_) {
          /* a live hint must never break the form */
        }
      };
      overlay.addEventListener("input", fire);
      overlay.addEventListener("change", fire);
      fire();
    }
  });
}

export function showConfirmModal({
  title,
  body,
  okLabel = "OK",
  cancelLabel = "Cancel",
  tone = "primary",
}) {
  return new Promise((resolve) => {
    const overlay = modalDialog("", { role: "alertdialog" });
    const okClass = tone === "danger" ? "danger" : "primary";
    overlay.innerHTML = html`
      <h2 class="modal-title">${title}</h2>
      <div class="modal-body">
        <p class="modal-copy">${body}</p>
      </div>
      <div class="modal-footer">
        <button class="btn ghost" data-action="cancel" type="button">${cancelLabel}</button>
        <button class="btn ${okClass}" data-action="ok" type="button">${okLabel}</button>
      </div>
    `;
    const cancelBtn = overlay.querySelector('[data-action="cancel"]');
    const okBtn = overlay.querySelector('[data-action="ok"]');
    let settled = false;
    const close = (value) => {
      if (settled) return;
      settled = true;
      dismiss();
      resolve(value);
    };
    const dismiss = openModal(overlay, { initialFocus: cancelBtn, onDismiss: () => close(false) });
    cancelBtn.addEventListener("click", () => close(false));
    okBtn.addEventListener("click", () => close(true));
  });
}
