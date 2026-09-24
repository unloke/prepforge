# Games and Teams redesign

The layouts below were considered before implementation. Both pages keep their existing actions and API calls.

## Games

1. **Timeline:** chronological full-width game cards, with actions revealed inside each card. Simple, but a dense sample becomes a long page and repeats detail across rows.
2. **Split inspector:** compact game list on the left, selected game on the right. Efficient for scanning, but a second narrow column competes with the source picker.
3. **Review desk (chosen):** source and sample controls in a narrow left rail; selected game, result filters, and a compact ledger in the main area. The move line and next action get priority while the ledger stays scannable.

At phone width, the control rail and review desk stack. Selecting a ledger row replaces the focused game; filters and Train, Build, Analyze, and Lichess links retain their existing behavior.

## Teams

1. **Tile gallery:** every team as a card, with detail expanding below the grid. Easy to browse a few teams, but pushes the selected team offscreen in dense states.
2. **Accordion:** each team expands its members and repertoires inline. Compact at rest, but repeated detail controls make a long list harder to navigate.
3. **Directory and workspace (chosen):** searchable team directory on the left, selected team's members and shared repertoires in the main workspace, and incoming shared repertoires beneath. The selected team remains visible even with many teams.

At phone width, these sections stack. Existing create, invite, rename, delete, membership, share, copy, and unshare controls remain attached to the same IDs and handlers.
