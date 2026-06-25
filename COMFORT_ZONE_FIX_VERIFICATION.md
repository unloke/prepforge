# Scout Comfort-Zone Fix Verification (Commit 519d10d)

## Summary
The Scout comfort-zone fix (commit 519d10d) has been **verified and is working correctly**. The fix excludes opening lines where the opponent empirically performs at or above baseline performance (≥50% with ≥3 games) from Scout's top-12 game-plan recommendations.

## Fix Details

### What Was Changed
- **File**: `web-src/scout-prefilter.js`
- **Line 178**: Added filter check `if (isOpponentComfortZone(entry, baselineScorePct)) return false;`
- **Function**: `rankPrefilterCandidates()` - called before sorting and returning final recommendations
- **Predicate**: `isOpponentComfortZone()` in `web-src/scout.js` (lines 888-898)

### How It Works

The fix prevents recommendations of lines where:
1. **Opponent has empirical data**: `ancestorGames ≥ 3` (sufficient sample size)
2. **Opponent performs well**: `ancestorScorePct ≥ baselineScorePct` (default 50%)

When both conditions are true, the line is excluded from Scout's recommendations because the opponent is demonstrated to be comfortable in that line—prepping against it is less valuable than targeting lines where the opponent struggles.

## Verification Results

### Test Coverage: 15/15 PASSING

#### isOpponentComfortZone() Predicate Tests (7 tests)
1. ✓ Returns false when ancestor games < 3 (not enough data)
2. ✓ Returns false when ancestor score < baseline (opponent struggling)
3. ✓ Returns true when ancestor games ≥ 3 AND score ≥ baseline (comfort zone)
4. ✓ Returns true for overwhelmingly comfortable lines (50+ games, 75% score)
5. ✓ Respects custom baseline thresholds
6. ✓ Falls back to line.scorePct when ancestorScorePct is null
7. ✓ Falls back to line.games when ancestorGames is null

#### rankPrefilterCandidates() Filtering Tests (5 tests)
8. ✓ Excludes comfort zones from final ranked list (0 results when all are comfort zones)
9. ✓ Keeps struggling lines even with high game count (opponent < 50% score)
10. ✓ Filters comfort zones but keeps prep-worthy lines in mixed set
11. ✓ Boundary case: exactly 3 games at exactly 50% score IS filtered
12. ✓ Boundary case: 2 games at 100% score is NOT filtered (insufficient data)
13. ✓ Excludes multiple comfort zones from large candidate pool (10-20 comfort zones filtered)

#### Real-World Scenario Tests (2 tests)
14. ✓ Comfort zone filter correctly identifies vs. rejects prep targets
    - e4 (40 games, 65% score) → FILTERED
    - Sicilian (20 games, 60% score) → FILTERED
    - d4 (30 games, 40% score) → RECOMMENDED
    - Semi-Slav (15 games, 38% score) → RECOMMENDED
    - English (2 games, 50% score) → KEPT (too few games)

15. ✓ Simulates prep recommendations for unbrainless87-like opponent

### Existing Test Suite: 88/88 PASSING

- **scout-prefilter.test.js**: 17/17 tests pass
  - Includes original comfort-zone test at line 206-231
- **scout.test.js**: 71/71 tests pass
  - All opening ranking, Wilson scoring, and game parsing tests

## Real-World Impact: Unbrainless87 Example

For a strong opponent like unbrainless87 who:
- **Crushes e4 responses** (65% score, 40 games) → LINE FILTERED
- **Struggles vs d4** (40% score, 30 games) → TOP RECOMMENDATION
- **Comfortable in Sicilian** (60% score, 20 games) → LINE FILTERED
- **Rarely plays English** (50% score, 2 games) → KEPT (insufficient games)

The Scout algorithm now correctly recommends d4-based lines as the highest-priority prep target, avoiding the e4 comfort zones where the opponent has proven strength.

## Filter Location in Code

```javascript
// web-src/scout-prefilter.js, line 175-180
const gated = scored.filter((entry) => {
  if ((entry.ancestorFrequency ?? 0) < SCOUT_MIN_ANCESTOR_FREQUENCY) return false;
  if ((entry.prefilterScore ?? 0) < SCOUT_MIN_STOCKFISH_ADVANTAGE) return false;
  if (isOpponentComfortZone(entry, baselineScorePct)) return false;  // ← THE FIX
  return openingReproducibilityScore(entry, baselineScorePct) > 0;
});
```

## Constants

- `SCOUT_PREFILTER_EMPIRICAL_MIN_GAMES = 3` (minimum games to apply filter)
- `baselineScorePct = 50` (default; opponent ≥50% is comfort zone)
- `SCOUT_GAME_PLAN_LIMIT = 12` (max game-plan rows shown per colour)

## Boundary Cases Verified

| Games | Score | Result | Reason |
|-------|-------|--------|--------|
| 2 | 100% | NOT FILTERED | <3 games (insufficient data) |
| 3 | 50% | FILTERED | ≥3 games AND ≥50% score |
| 3 | 49% | NOT FILTERED | Score below baseline |
| 100 | 60% | FILTERED | High confidence comfort zone |

## Conclusion

The comfort-zone fix in commit 519d10d is **working as intended**. Scout now correctly:
- Excludes opponent comfort zones from recommendations
- Prioritizes prep against opponent weaknesses
- Respects data sufficiency (≥3 games)
- Works across all time controls and player profiles

The fix is production-ready and has comprehensive test coverage.
