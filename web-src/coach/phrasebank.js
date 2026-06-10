// Phrase banks — the "voice" layer for the coach.
//
// Each exported array is ONE clause-shaped slot ("how do we open a blunder", "how do
// we phrase the punishing reply", "how do we recommend the better move"...). Every
// template within a bank shares the same shape — same leading case, same placeholders,
// same trailing punctuation — so any template in the bank can be dropped into its slot
// and the result is valid English, regardless of which one wins.
//
// commentary.js fills `{placeholder}` tokens with the facts for THIS move and picks
// one template per slot, independently, via a per-slot deterministic seed (seedFor).
// A handful of independently-varying slots compose into a huge number of distinct
// sentences without writing full sentences by hand — e.g. 10 leads x 8 hang-descriptions
// x 5 punishes x 6 better-moves = 2400 just for one branch — and tweaking how we phrase
// "X is now winning" instantly reaches every sentence that uses that slot.

export function fmt(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ""));
}

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// A per-slot deterministic seed: same move + same slot -> same pick, always. Different
// slots (different `salt`) vary independently, so picking a new "lead" doesn't lock in
// the same index for "punish" — that independence is what gives the combinatorics range.
export function seedFor(f, salt) {
  const base = Number.isFinite(f.ply) ? f.ply : hashStr((f.san || "") + (f.uci || ""));
  return hashStr(`${salt}:${f.san || ""}:${f.uci || ""}:${base}`);
}

export function pick(seed, bank) {
  return bank[((seed % bank.length) + bank.length) % bank.length];
}

// Pick a template from `bank` for this move+slot and fill it with `vars`.
export function choose(f, salt, bank, vars) {
  return fmt(pick(seedFor(f, salt), bank), vars || {});
}

// --- conditional "tail" clause shapes -----------------------------------------------
// A reply's idea (e.g. "freeing g4", "forking the rook and queen") folded into a
// punish clause that names the reply itself. "" when there's no idea to add.
export function tailComma(tail) {
  return tail ? `${tail}, ` : "";
}
export function tailDash(tail) {
  return tail ? `, ${tail}` : "";
}
export function tailParen(tail) {
  return tail ? ` (${tail})` : "";
}

// =====================================================================================
// Checkmate delivered — {san} already carries the '#'.
// =====================================================================================
export const MATE_DELIVERED = [
  "Checkmate — {san} ends it. Game over.",
  "That's mate — {san}, and there's nothing to be done about it.",
  "Checkmate! {san} brings the curtain down.",
  "{san} — and that's checkmate. Well played.",
  "Mate! {san} finishes the game right there.",
  "{san} delivers checkmate. That's the game.",
  "Checkmate with {san} — nothing more to say.",
  "And that's mate — {san} seals it.",
  "That's the game — {san} is checkmate.",
  "{san}, and it's mate. Nothing left to play for.",
];

// =====================================================================================
// Brilliant — grounded in the Maia/Stockfish disagreement.
// =====================================================================================
export const BRILLIANT_LEAD = [
  "Brilliant! Almost no one would find {san} — {looks} it's the best move on the board and keeps {me} {stand}.",
  "Brilliant — {san} is the kind of move you don't expect a person to find. {looksCap} it's simply best, and {me} stays {stand}.",
  "Brilliant! {looksCap} {san} is exactly right, holding {me} {stand}.",
  "A real brilliancy — {san}. {looksCap} it's the only move that works here, leaving {me} {stand}.",
  "Brilliant! {san} is a move engines find and humans don't. {looksCap} it keeps {me} {stand}.",
  "That's brilliant — {san}. {looksCap} it turns out to be the best move on the board, and {me} stays {stand}.",
  "Wow — {san} is brilliant. {looksCap} it's correct, and {me} comes out {stand}.",
  "Brilliant move, {san}. {looksCap} it's the engine's top choice, keeping {me} {stand}.",
  "Brilliant find — {san}. {looksCap} it holds everything together, and {me} is {stand}.",
  "{san} is brilliant. {looksCap} nothing else even comes close, and {me} stays {stand}.",
];

export const LOOKS_HANGS = [
  "it looks like it just hangs the {piece}, but",
  "it seems to give away the {piece} for free, but",
  "on the surface it drops the {piece}, but",
  "at first glance the {piece} looks lost, but",
  "it appears to blunder the {piece}, but",
  "it looks like the {piece} just falls, but",
];

export const LOOKS_PLAIN = [
  "it looks wrong at a glance, but",
  "it looks like a mistake at first, but",
  "the idea isn't obvious at all, but",
  "it doesn't look like much, but",
  "it looks almost careless, but",
  "at a glance it looks like a slip, but",
];

// How rarely a human finds this — translated from Maia's policy probability. All
// entries say "players" (the Brilliant-grounding test checks for it).
export const RARITY_TIER1 = [ // maiaHumanProb < 0.01
  "virtually no human players would even consider it",
  "almost no players at the board would even look at it",
  "hardly any players would dare to play it",
];
export const RARITY_TIER2 = [ // < 0.03
  "only about one in fifty players would try it",
  "only a tiny fraction of players would find it",
  "barely one in fifty players would go for it",
];
export const RARITY_TIER3 = [ // < 0.06
  "only a handful of players would go for it",
  "very few players would risk it",
  "only a small minority of players would try it",
];
export const RARITY_TIER4 = [ // else
  "few players would risk it",
  "not many players would choose it",
  "relatively few players would play it",
];

// The grounded "why": the rarity (capitalised, sentence-initial) plus the Maia/Stockfish
// gap. All entries name "players" and "Stockfish" (Brilliant-grounding test).
export const BRILLIANT_WHY = [
  "{rarityCap} — most players would read this position as {maiaStand} for {me}, while Stockfish already sees the truth.",
  "{rarityCap}. To most players this looks {maiaStand} for {me} — but Stockfish already knows better.",
  "{rarityCap} — to most players this looks {maiaStand} for {me}; Stockfish has already found the truth.",
  "{rarityCap}, and to most players the position reads as {maiaStand} for {me}. Stockfish sees further.",
];

// =====================================================================================
// Blunder / Mistake leads.
// =====================================================================================
export const BLUNDER_LEAD = [
  "Ouch — that's a blunder.",
  "That's a blunder, I'm afraid.",
  "Careful — that's a blunder.",
  "Yikes — that's a blunder.",
  "That's a real blunder.",
  "Oof, that's a blunder.",
  "A costly blunder, this one.",
  "That's a serious blunder.",
  "Big mistake — that's a blunder.",
  "That one stings — a blunder.",
];

export const MISTAKE_LEAD = [
  "Not quite — that's a slip.",
  "Hmm, that's a mistake.",
  "That's a bit of a slip.",
  "A mistake creeps in here.",
  "Not the best choice — a mistake.",
  "A bit careless — that's a mistake.",
  "That one's a mistake.",
  "Not ideal, but not a disaster — a mistake.",
  "A small mistake here.",
  "That's a mistake, though not fatal.",
];

// --- walking into a forced mate -------------------------------------------------
export const IN_MATE_NET = [
  "{san} walks into a forced mate — after {reply}, {extra}{opp} finishes by force.",
  "{san} allows a forced mate — after {reply}, {extra}{opp} mates by force from here.",
  "That's losing on the spot — {san} runs into a mating net; after {reply}, {extra}{opp} finishes it.",
];

// --- stepping past a forced mate -------------------------------------------------
export const MISSED_MATE = [
  "{me} walks straight past a forced mate — {bestSan} ended it on the spot.",
  "There was mate on the board and {me} missed it — {bestSan} would have finished the game.",
  "{bestSan} was mate, but {me} played something else instead.",
  "A forced mate was sitting right there ({bestSan}), and {me} let it go.",
];

// --- hanging a piece outright -----------------------------------------------------
export const HANG_DESC = [
  "{san} just drops the {piece} on {sq}",
  "{san} leaves the {piece} on {sq} hanging",
  "{san} hangs the {piece} on {sq} outright",
  "{san} gives away the {piece} on {sq} for nothing",
  "{san} simply loses the {piece} on {sq}",
  "{san} puts the {piece} on {sq} en prise",
  "{san} drops the {piece} on {sq} without a fight",
  "{san} leaves the {piece} on {sq} completely undefended",
];

export const HANG_PUNISH_WITH_REPLY = [
  "after {reply}, {opp} is {standing}.",
  "{reply} follows, and {opp} is {standing}.",
  "after {reply}, that leaves {opp} {standing}.",
  "{reply} picks it up — {opp} is {standing} now.",
  "after {reply}, {opp}'s position turns {standing}.",
];

export const HANG_PUNISH_NO_REPLY = [
  "{opp} is {standing} now.",
  "that leaves {opp} {standing}.",
  "{opp}'s position is {standing} as a result.",
  "{opp} ends up {standing}.",
];

// --- missing a free piece / forced win --------------------------------------------
export const MISSED_WIN = [
  "{san} misses it — there was a free {piece} on {sq} going begging, and {bestSan} grabs it instead.",
  "{san} lets a free {piece} on {sq} slip away — {bestSan} would have scooped it up.",
  "There was a {piece} hanging on {sq}, ripe for the taking, but {san} looks elsewhere — {bestSan} was the grab.",
  "{bestSan} simply wins the {piece} on {sq}; {san} passes it up instead.",
];

// --- the "quiet" error: no single piece hangs ---------------------------------------

// The played move plus its idea, as the subject of "... loses material" / "... hands
// over the initiative". When there's no idea, commentary.js uses the bare SAN instead.
export const OPENER_WITH_IDEA = [
  "{san}, {idea},",
  "{san} ({idea})",
  "{san} — the idea was {idea} —",
];

export const LOSE_MATERIAL_VERB = [
  "loses material",
  "costs material",
  "gives material away",
  "drops material",
  "hands over material",
  "bleeds material",
];

export const LOSE_MATERIAL_TEMPLATE = [
  "{opener} {verb} — {punish}",
  "{opener} {verb}: {punish}",
];

// The forcing line's material count, with the punishing reply named when we have one.
export const PUNISH_WITH_REPLY_COUNT = [
  "after {reply}, {tailComma}{opp} ends up {phrase} ahead.",
  "{reply} nets {opp} {phrase}.",
  "after {reply}{tailDash}, {opp} comes away {phrase} up.",
  "{reply} wins {opp} {phrase} on the spot{tailParen}.",
  "after {reply}, {opp} is simply {phrase} to the good{tailParen}.",
  "{reply} is the point — {tailComma}{opp} ends up {phrase} up.",
];

export const PUNISH_NO_REPLY_COUNT = [
  "{opp} ends up {phrase} ahead in the line that follows.",
  "the position settles with {opp} {phrase} up.",
  "{opp} comes out {phrase} to the good from here.",
  "that's {phrase} gone, just like that.",
];

// What the move costs when nothing is materially lost — initiative/tempo, by phase.
export const PHASE_HINT_OPENING = [
  "gives away precious development time",
  "loses a tempo in the opening",
  "lets the development lead slip",
  "costs a valuable opening tempo",
  "falls behind in development",
];
export const PHASE_HINT_MIDDLEGAME = [
  "hands over the initiative",
  "lets the initiative slip away",
  "gives up the momentum",
  "cedes the initiative",
  "loses the thread of the position",
];
export const PHASE_HINT_ENDGAME = [
  "gives up a tempo the endgame can't spare",
  "loses precious time in the endgame",
  "costs a critical tempo here",
  "hands over the move that matters most",
  "lets a key tempo slip in the endgame",
];

// The resulting standing, as a clause continuing the sentence (lowercase-start; cap()
// it when it needs to open a new sentence).
export const STANDING_TAIL = [
  "{opp} is now {standing}.",
  "that leaves {opp} {standing}.",
  "{opp}'s position is {standing} from here.",
  "{opp} comes away {standing}.",
];

// With a named punishing reply (folded in after an em-dash/semicolon — one sentence).
export const INITIATIVE_WITH_PUNISH = [
  "{opener} {phaseHint} — {punish} {standingTail}",
  "{opener} {phaseHint}; {punish} {standingTail}",
];

// No reply to name — the standing can stand alone as its own sentence.
export const INITIATIVE_NO_PUNISH = [
  "{opener} {phaseHint} — {standingTail}",
  "{opener} {phaseHint}, and {standingTail}",
  "{opener} {phaseHint}. {standingTailCap}",
];

// The recommendation: what to play instead, and what it keeps/saves (via {merit}).
export const BETTER_MOVE = [
  "{bestSan} was the move{merit}.",
  "{bestSan} kept things together{merit}.",
  "Instead, {bestSan}{merit}.",
  "{bestSan} was the way to go{merit}.",
  "Better was {bestSan}{merit}.",
  "{bestSan} held it all{merit}.",
];

// =====================================================================================
// Inaccuracy.
// =====================================================================================
export const INACC_HEAD_WITH_IDEA = [
  "{san} is a touch loose — the idea ({idea}) is fine, but it isn't the sharpest try.",
  "A shade inaccurate — {san}, {idea}, only there was something cleaner.",
  "{san} ({idea}) is reasonable, but not quite the most precise.",
  "Nothing's broken — {san}, {idea} — but it's a touch inaccurate.",
];

export const INACC_HEAD_PLAIN = [
  "A touch loose — {me} lets a little of the edge slip.",
  "Slightly inaccurate — no real harm done, just not the sharpest try.",
  "A small inaccuracy — the position's still fine, only a hair less precise.",
  "Not the sharpest — a small inaccuracy creeps in.",
  "A minor slip — {me} loses a touch of the edge.",
];

export const INACC_CLEANER = [
  " {bestSan} would have kept things tidier{payoff}.",
  " {bestSan} was a touch more precise{payoff}.",
  " {bestSan} kept a firmer grip{payoff}.",
  " A little sharper was {bestSan}{payoff}.",
  " {bestSan} held the edge better{payoff}.",
];

// All entries say "edges ahead" (the inaccuracy-flip test checks for it).
export const INACC_FLIP = [
  " {opp} edges ahead now — {me} is {standing}.",
  " Now {opp} edges ahead — {me} is {standing}.",
  " {opp} edges ahead from here — {me} is {standing}.",
  " From here, {opp} edges ahead — {me} is {standing}.",
  " {opp} edges ahead as a result — {me} is {standing}.",
];

// =====================================================================================
// Great — the only move, or a decisive winning blow.
// =====================================================================================
export const GREAT_DECISIVE = [
  "{san} — the strongest move on the board, and {me} comes out up {phrase}. Clean.",
  "Great — {san} snaps off {phrase} and nothing else came close. Nicely done.",
  "Best of the bunch — {san} wins {phrase}, and only this move does it so cleanly.",
  "{san} is the killer blow, picking up {phrase} outright.",
  "That's the shot — {san} wins {phrase}, no question.",
  "{san} — decisive. {me} grabs {phrase} and the rest is academic.",
];

export const GREAT_ONLY_MOVE = [
  "Great find — {san} was the only move that holds everything together. Well spotted.",
  "Great move. {san} is the one move that keeps {me} afloat — nicely found.",
  "The only move, and you found it — {san} is the lifeline here. That's how games get saved.",
  "{san} — and it's the only move. Everything else loses; this one survives.",
  "Superb — {san} was the single move that kept {me} in the game.",
  "Right on the only square — {san} is the one move that doesn't lose. Great find.",
];

// =====================================================================================
// Best / Good.
// =====================================================================================
export const LEAD_BEST = ["Good move —", "Nice —", "Solid —", "Well played —", "Spot on —", "That's the move —"];
export const LEAD_GOOD = ["Looks fine —", "Reasonable —", "That works —", "Decent —", "Not bad —", "Fine choice —"];

export const POINT_MATERIAL = [
  " {me} is up {phrase} now.",
  " That puts {me} up {phrase}.",
  " {me} comes away up {phrase}.",
  " {me} banks {phrase} for the trouble.",
];

export const POINT_TARGET = [
  " Now the {piece} on {sq} is feeling the heat.",
  " The {piece} on {sq} is in trouble now.",
  " That piles the pressure on the {piece} on {sq}.",
  " The {piece} on {sq} is a target now.",
];

export const POINT_ENDGAME = [
  " The extra {phrase} should tell in the endgame.",
  " That extra {phrase} matters a lot in an endgame like this.",
  " In an endgame, {phrase} extra is significant.",
];

export const STAND_TAIL = [
  " {me} is {standing}.",
  " That keeps {me} {standing}.",
  " {me} remains {standing}.",
  " {me} stays {standing}.",
];
