# Grok Delegation Policy

This policy controls Scout work while Grok quota is constrained. It supplements `AGENTS.md` and the CLI wrapper; it does not change research gates or permit burned holdout reuse.

## Normal division of work

While `grok -p` remains available, use `agent-tools/grok-consult.ps1` as a general-purpose helper rather than a consultation-only/read-only channel. Its default `-CapabilityMode open` allows Grok to inspect and modify the repository and run commands as directed by the user. Use `-CapabilityMode plan` or `-CapabilityMode readonly` when a task explicitly needs a restricted pass.

Open mode is user-dispatched, not unattended permission to invent unrelated work: provide a precise task, scope, and verification expectation. The wrapper uses `--permission-mode auto --always-approve` in open mode, so callers must treat it as an executing agent and review its diff/output.

Before the first Grok task in a work session, run `grok models` once and use only model IDs it actually lists.

## Effort assignment

Every Grok 4.5 call must explicitly select an effort tier. The read-only wrapper defaults to `medium` so an omitted flag cannot silently spend `high` quota.

### `low`

Use for bounded, mostly mechanical work:

- locate files, symbols, tests, and prior protocols;
- summarize supplied evidence without proposing a new method;
- enumerate obvious edge cases or checklist items;
- perform a first-pass diff scan;
- implement a tiny, fully specified change with pinned tests and no architectural choice.

A `low` result may identify uncertainty, but it must not make the final scientific or architectural decision.

### `medium`

Use for the default substantive work:

- design a candidate or protocol from a precise research question;
- compare a small number of approaches;
- write an implementation plan or nontrivial implementation from a complete spec;
- diagnose a failing test or audit interactions across several files;
- review whether a proposal is merely a renamed burned method;
- critique a `low` result and decide whether escalation is justified.

Start at `medium` whenever the task requires real synthesis but is not the final irreversible gate.

### `high`

Reserve for one of these explicit roles:

- final implementation of a difficult algorithm after the spec and tests are fixed;
- final adversarial review before freezing a protocol/package;
- deciding a genuine research fork after a `medium` pass leaves material ambiguity;
- resolving a safety/correctness issue whose wrong answer would invalidate the experiment.

Do not use `high` for file discovery, routine summaries, duplicated brainstorming, or retries of an unchanged prompt. Prefer one focused `high` call over several parallel calls. Record in the prompt what unresolved question requires `high`.

## Escalation sequence

1. Use `low` for inventory/mechanical evidence collection when useful.
2. Use `medium` for synthesis, design, and normal implementation.
3. Escalate only the unresolved core question to `high`; do not rerun the whole task at `high`.
4. Claude independently checks the answer against repository evidence and tests.

## Quota fallback

If `grok -p` explicitly reports exhausted usage/quota or refuses because the account has no remaining capacity:

1. Do not repeatedly retry or downgrade the same call merely to probe the limit.
2. Preserve the prepared prompt/spec in the work log or task file.
3. Claude temporarily takes over the blocked reasoning or implementation directly in the main session.
4. Claude still performs the normal diff review and verification, and clearly records that the quota fallback was used.
5. Do not replace Grok with Claude subagents.
6. Once Grok usage resets, return to the normal division of work; do not continue the fallback by inertia.

Authentication errors, malformed prompts, tool cancellation, ordinary implementation failures, and process timeouts are not proof of quota exhaustion. The wrapper may make only bounded retries for eligible transient/incomplete results, subject to `-ProcessTimeoutSec` and the shared `-OverallTimeoutSec` deadline; in open mode, timeout retries are disabled by default because replaying a mutation may duplicate side effects. Add `-AllowRetrySideEffects` only when replay is safe and intentional. It terminates timed-out process trees and releases the exclusive lock. Diagnose those normally before invoking the quota fallback. Consumers must require wrapper exit code 0 and JSON `success=true`/`complete=true` before trusting the result.
