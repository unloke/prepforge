# Scout, Games, Teams plan (2026-09-24)

Baseline: `origin/main` at `4c0488c`. Work only in `feat/scout-plausibility-games-teams-20260924`.

## Findings to verify before implementation

Scout's production path is observed games → exact game branches and display trie → engine-free prior and route gate → leaf-only Stockfish prefilter → capped Maia enrichment → game plan. The current `routeReach` multiplies opponent conditional shares, so a long sequence of individually reasonable decisions can fail the fixed 2% gate. `triePrefixStats` stops at the display trie depth of 16, so later decisions are unchecked. `offModal` remains diagnostic and is absent from the prior and Stockfish ranking. Candidate branches are observed game paths.

## Research and selection

Compare on chronological real-player samples of 20, 50, 100, 300, and 1000 games (where available): minimum opponent conditional probability; lower percentile/weakest decision; and geometric mean (depth-normalized log probability). Hold out later games. Report impossible and very-low-probability selected routes, decision hit rate, depth distribution, candidate count, distinct Stockfish leaf FENs, and Maia candidate count. Trace every opponent decision for representative selected and rejected routes, including full position, move, parent/move games, probability, and gate result. Select the rule that rejects a single implausible opponent choice without automatically penalizing depth or requiring repeated whole routes. Keep candidate generation confined to observed games and do not add node-level Maia reads.

## Games IA options

1. Chronological timeline with expandable cards: clear sequence, poor scan density.
2. Source rail + large focused game + ledger (current): focused detail, but the scan list competes with the preview and states are hard to compare.
3. **Preparation triage table + persistent inspector (chosen direction):** compact rows with a strong status column and departure point; status filters and source controls above; selected row reveals move context, expected reply, and Analyze/Build/Train in a stable inspector. Mobile becomes list → detail. Implement after inspecting actual render/data contracts.

## Teams IA options

1. Team card gallery: good for few teams, weak at scale.
2. Searchable directory + generic workspace (current): selected team stays visible, but role, members, shared repertoire, and incoming shares lack task priority.
3. **Team operations hub (chosen direction):** compact team rail with role/member counts; selected-team header owns invite/manage; separate Members and Shared repertoires sections with their own actions; incoming shares as an independent inbox with Copy. Mobile stacks these in task order. Implement after inspecting handlers and payloads.

## Implementation and verification sequence

1. Build a real-data benchmark and traces; make the Scout gate change with focused tests; measure expensive-stage bounds.
2. Rework Games structure and interaction, keeping API/action contracts; verify empty, normal, dense.
3. Rework Teams structure and interaction, keeping create/invite/manage/share/copy flows; verify empty, normal, dense.
4. Browser review at 1440×900, 1920×1080, and phone width; full local GitHub CI equivalents; push PR, then wait for green CI. No merge.

## Implemented choice and browser review

Games now presents a status-led ledger and a persistent preparation inspector. The selected game shows the move line, departure explanation, expected move when available, and the context-specific Train, Build, or Analyze action. Status filters remain above the ledger. The source and sample controls sit above the review so the scan area gets most of the width.

Teams now presents a compact directory and a selected-team workspace with Members and Shared repertoires tabs. Invite/manage actions live in the team header; incoming shares remain a separate inbox with Copy. Existing server calls and element IDs remain intact.

`scripts/verify-workbench-layout.mjs` exercises empty, normal, and dense layout states at 1440×900, 1920×1080, and 390×900, checks horizontal overflow, and clicks Games selection and Teams tabs. `scripts/verify-scout-dense-real.mjs` renders the actual Scout section builder in Chromium with 1,000 parsed EricRosen games at those same widths. The Scout candidate benchmark and route trace use those games through the production trie and branch routines.
