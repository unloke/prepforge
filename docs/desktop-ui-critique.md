# Desktop UI critique (1440 × 900 baseline)

Observed in Chromium on the current `origin/main` build, both anonymous and signed in. The primary mode is **Operate**: the user studies positions, edits a repertoire, rehearses lines, and reviews data.

| Surface | Finding | Priority | Design response |
| --- | --- | --- | --- |
| Analyze | The 778 px board leads correctly. The right column uses an oversized, mostly empty Coach box and gives the PGN editor the same visual weight as the review workflow. | P1 | Keep the board budget; compress the Coach's idle state and make source/history read as supporting sections. |
| Build | The board remains large, but the empty repertoire prompt looks like a floating card inside a vacant column. | P2 | Give the right workspace a continuous, clearly grouped starting state and stronger primary action. |
| Train | Training modes, switch, and start action are recognizable. The board is dominant; sidebar rhythm alternates between dense controls and large unstructured gaps. | P2 | Align setup controls to a compact task panel with a stable progress region. |
| Games | One shallow full-width card leaves the rest of the viewport empty before data loads. The filters and action are packed beside the title. | P1 | Separate context from controls and give the results area a stable minimum height. |
| Scout | Source selection, color, start, explanation, and count compete in one line. Empty space below the card hides the intended evidence/results structure. | P1 | Organize source selection and run controls into clear groups; reserve a result canvas. Preserve ranking logic. |
| Teams | The two-column model is useful, but the left cards and right empty state have weak hierarchy and uneven padding. | P2 | Use a consistent master/detail split and a deliberate empty detail panel. |
| Topbar/status | Navigation is legible. Status may occupy an unpredictable width next to the account controls, creating a cramped center at intermediate widths. | P1 | Reserve a status region and constrain its text without changing nav order or keyboard behavior. |
| Settings | Cards are readable but use a narrow 920 px column with broad side gutters and repeated row separators. | P2 | Widen the settings workspace, tighten related controls, and distinguish section headings from values. |

The current system has strong warm board colors, amber actions, explicit focus styling, and a coherent light/dark token pair. The redesign retains those functional cues. The major spatial thesis is a large stable board with a denser, scrollable instrument column; data pages use broad working canvases with task controls visibly distinct from results. All view and test IDs remain in place.
