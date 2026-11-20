import { showInputModal } from "../core/modals.js";

let dialogSequence = 0;

export function readGenerateInt(raw, min, max) {
  const n = Number(String(raw ?? "").trim() || NaN);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error("Invalid Generate value");
  return n;
}

export function generateFieldError(input) {
  if (input.validity.valueMissing || input.validity.badInput) return "Enter a number.";
  if (input.validity.rangeUnderflow || input.validity.rangeOverflow) return `Use ${input.min}–${input.max}.`;
  if (input.validity.stepMismatch) return input.step === "1" ? "Use a whole number." : `Use steps of ${input.step}.`;
  return "";
}

export function showBuildGenerateDialog(options) {
  const errorPrefix = `generate-error-${++dialogSequence}`;
  let bound = false;
  let submitted = false;
  return showInputModal({ ...options, onInput: (values, overlay) => {
    const inputs = [...overlay.querySelectorAll('input[type="number"]')];
    const validate = () => {
      let firstInvalid;
      for (const input of inputs) {
        const error = generateFieldError(input);
        let message = overlay.querySelector(`#${errorPrefix}-${input.name}`);
        if (!message) {
          message = document.createElement("span");
          message.id = `${errorPrefix}-${input.name}`;
          message.className = "auth-error";
          message.setAttribute("role", "alert");
          input.after(message);
          input.setAttribute("aria-describedby", message.id);
        }
        message.textContent = error;
        message.hidden = !error;
        input.setAttribute("aria-invalid", String(!!error));
        if (error) firstInvalid ||= input;
      }
      return firstInvalid;
    };
    if (!bound) {
      bound = true;
      for (const input of inputs) input.required = true;
      const submit = (event) => {
        if (event.type === "click" ? !event.target.closest('[data-action="ok"]')
          : event.key !== "Enter" || !event.target.matches('input[type="number"]')) return;
        submitted = true;
        const invalid = validate();
        if (!invalid) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        invalid.focus();
      };
      overlay.addEventListener("click", submit, true);
      overlay.addEventListener("keydown", submit, true);
    }
    if (submitted) validate();
    if (inputs.every((input) => input.validity.valid)) options.onInput?.(values, overlay);
    else {
      const estimate = overlay.querySelector('[data-note="estimate"] b');
      if (estimate) estimate.textContent = "—";
    }
  } });
}
