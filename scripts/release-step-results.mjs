export function requiredStepFailures(steps, requiredIds) {
  const results = new Map(steps.map((step) => [step.id, step]));
  return [...requiredIds].filter((id) => results.get(id)?.pass !== true);
}
