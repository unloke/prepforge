// Move grades as the UI shows them: the colour group each stored classification
// belongs to and the glyph it carries. One table for the board badge, the move list,
// the eval chart and the classification bars, so they can never disagree.

export const CLASS_GROUPS = [
  { key: "brilliant", label: "Brilliant", members: ["brilliant"] },
  { key: "great", label: "Great", members: ["great"] },
  { key: "good", label: "Good", members: ["best", "excellent", "good", "book"] },
  { key: "inaccuracy", label: "Inaccuracy", members: ["inaccuracy"] },
  { key: "mistake", label: "Mistake", members: ["mistake"] },
  { key: "blunder", label: "Blunder", members: ["blunder"] },
  { key: "missed", label: "Missed", members: ["missed_win", "missed_tactic"] },
];

export const CLASS_GROUP_OF = Object.freeze(
  Object.fromEntries(CLASS_GROUPS.flatMap((g) => g.members.map((m) => [m, g.key])))
);

const GROUP_GLYPH = {
  brilliant: "!!",
  great: "!",
  good: "✓",
  inaccuracy: "?!",
  mistake: "?",
  blunder: "??",
  missed: "×",
};

export function classGroup(classification) {
  return CLASS_GROUP_OF[String(classification || "").toLowerCase()] || null;
}

export function classBadgeSymbol(classification) {
  return GROUP_GLYPH[classGroup(classification)] || "";
}
