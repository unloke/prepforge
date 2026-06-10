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
// sentences without writing full sentences by hand, and tweaking how we phrase
// "X is now winning" instantly reaches every sentence that uses that slot.
//
// House style: NO em-dashes. They read as machine-written; we use commas, periods,
// "and", "so", colons and parentheses instead. Keep it warm and plain-spoken.

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
  "Checkmate. {san} ends it, and there's nothing to be done.",
  "That's mate. {san}, and the game is over.",
  "Checkmate! {san} brings the curtain down.",
  "{san}, and that's checkmate. Well played.",
  "Mate! {san} finishes the game right there.",
  "{san} delivers checkmate. That's the game.",
  "Checkmate with {san}. Nothing more to say.",
  "And that's mate. {san} seals it.",
  "That's the game. {san} is checkmate.",
  "{san}, and it's mate. Nothing left to play for.",
  "Game over. {san} is checkmate, clean and simple.",
  "{san} mates. A fitting way to finish.",
];

// =====================================================================================
// Brilliant — grounded in the Maia/Stockfish disagreement.
// =====================================================================================
export const BRILLIANT_LEAD = [
  "Brilliant! Almost no one would find {san}. {looksCap} it's the best move on the board, and {me} stays {stand}.",
  "Brilliant. {san} is the kind of move you don't expect a person to find. {looksCap} it's simply best, and {me} stays {stand}.",
  "Brilliant! {looksCap} {san} is exactly right, holding {me} {stand}.",
  "A real brilliancy, {san}. {looksCap} it's the only move that works, leaving {me} {stand}.",
  "Brilliant! {san} is a move engines find and humans don't. {looksCap} it keeps {me} {stand}.",
  "That's brilliant. {looksCap} {san} turns out to be the best move on the board, and {me} stays {stand}.",
  "Wow, {san} is brilliant. {looksCap} it's correct, and {me} comes out {stand}.",
  "Brilliant move, {san}. {looksCap} it's the engine's top choice, keeping {me} {stand}.",
  "Brilliant find, {san}. {looksCap} it holds everything together, and {me} is {stand}.",
  "{san} is brilliant. {looksCap} nothing else even comes close, and {me} stays {stand}.",
  "Brilliant! {looksCap} {san} is precisely the move, and {me} is left {stand}.",
  "A brilliant stroke, {san}. {looksCap} it is the one move that delivers, and {me} stays {stand}.",
];

export const LOOKS_HANGS = [
  "it looks like it just hangs the {piece}, but",
  "it seems to give away the {piece} for free, but",
  "on the surface it drops the {piece}, but",
  "at first glance the {piece} looks lost, but",
  "it appears to blunder the {piece}, but",
  "it looks like the {piece} simply falls, but",
  "the {piece} seems to be hanging, but",
  "you'd swear it loses the {piece}, but",
];

export const LOOKS_PLAIN = [
  "it looks wrong at a glance, but",
  "it looks like a mistake at first, but",
  "the idea isn't obvious at all, but",
  "it doesn't look like much, but",
  "it looks almost careless, but",
  "at a glance it looks like a slip, but",
  "it seems to do nothing special, but",
  "the point is easy to miss, but",
];

// How rarely a human finds this — translated from Maia's policy probability. All
// entries say "players" (the Brilliant-grounding test checks for it).
export const RARITY_TIER1 = [ // maiaHumanProb < 0.01
  "virtually no human players would even consider it",
  "almost no players at the board would even look at it",
  "hardly any players would dare to play it",
  "next to no players would ever pick it",
];
export const RARITY_TIER2 = [ // < 0.03
  "only about one in fifty players would try it",
  "only a tiny fraction of players would find it",
  "barely one in fifty players would go for it",
  "scarcely any players would choose it over the natural move",
];
export const RARITY_TIER3 = [ // < 0.06
  "only a handful of players would go for it",
  "very few players would risk it",
  "only a small minority of players would try it",
  "not many players would trust it",
];
export const RARITY_TIER4 = [ // else
  "few players would risk it",
  "not many players would choose it",
  "relatively few players would play it",
  "most players would pass it by",
];

// The grounded "why": the rarity (capitalised, sentence-initial) plus the Maia/Stockfish
// gap. All entries name "players" and "Stockfish" (Brilliant-grounding test).
export const BRILLIANT_WHY = [
  "{rarityCap}. Most players would read this position as {maiaStand} for {me}, while Stockfish already sees the truth.",
  "{rarityCap}. To most players this looks {maiaStand} for {me}, but Stockfish already knows better.",
  "{rarityCap}. To most players this looks {maiaStand} for {me}, and yet Stockfish has already found the truth.",
  "{rarityCap}, and to most players the position reads as {maiaStand} for {me}. Stockfish sees further.",
  "{rarityCap}. Where most players see {maiaStand} for {me}, Stockfish sees a path most never spot.",
];

// =====================================================================================
// Blunder / Mistake leads.
// =====================================================================================
export const BLUNDER_LEAD = [
  "Ouch, that's a blunder.",
  "That's a blunder, I'm afraid.",
  "Careful, that's a blunder.",
  "Yikes, that's a blunder.",
  "That's a real blunder.",
  "Oof, that's a blunder.",
  "A costly blunder, this one.",
  "That's a serious blunder.",
  "That one's going to hurt: a blunder.",
  "That one stings, a blunder.",
  "Sadly, that's a blunder.",
  "A heavy blunder here.",
];

export const MISTAKE_LEAD = [
  "Not quite, that's a slip.",
  "Hmm, that's a mistake.",
  "That's a bit of a slip.",
  "A mistake creeps in here.",
  "Not the best choice, a mistake.",
  "A bit careless, that's a mistake.",
  "That one's a mistake.",
  "Not ideal, though not a disaster: a mistake.",
  "A small mistake here.",
  "That's a mistake, though not fatal.",
  "Just a touch off, that's a mistake.",
  "That slips a little, a mistake.",
];

// --- walking into a forced mate -------------------------------------------------
export const IN_MATE_NET = [
  "{san} walks into a forced mate. After {reply}, {extra}{opp} finishes by force.",
  "{san} allows a forced mate. After {reply}, {extra}{opp} mates from here.",
  "That's losing on the spot: {san} runs into a mating net, and after {reply}, {extra}{opp} finishes it.",
  "{san} steps right into mate. After {reply}, {extra}{opp} wraps it up by force.",
];

// --- stepping past a forced mate -------------------------------------------------
export const MISSED_MATE = [
  "{me} walks straight past a forced mate. {bestSan} ended it on the spot.",
  "There was mate on the board and {me} missed it. {bestSan} would have finished the game.",
  "{bestSan} was mate, and {me} played something else instead.",
  "A forced mate was sitting right there with {bestSan}, and {me} let it go.",
  "{me} had mate in hand and passed it up. {bestSan} was curtains.",
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
  "{san} lets the {piece} on {sq} go for free",
  "{san} abandons the {piece} on {sq}",
];

// Standalone, capitalised sentences (joined after the hang description with a period).
export const HANG_PUNISH_WITH_REPLY = [
  "After {reply}, {opp} is {standing}.",
  "Once {reply} lands, {opp} is {standing}.",
  "After {reply}, that leaves {opp} {standing}.",
  "{opp} grabs it with {reply} and is {standing} now.",
  "After {reply}, {opp}'s position turns {standing}.",
  "{opp} plays {reply} and is suddenly {standing}.",
];

export const HANG_PUNISH_NO_REPLY = [
  "{opp} is {standing} now.",
  "That leaves {opp} {standing}.",
  "{opp}'s position is {standing} as a result.",
  "{opp} ends up {standing}.",
  "From here {opp} is {standing}.",
];

// --- missing a free piece / forced win --------------------------------------------
export const MISSED_WIN = [
  "{san} misses it: there was a free {piece} on {sq} going begging, and {bestSan} grabs it instead.",
  "{san} lets a free {piece} on {sq} slip away. {bestSan} would have scooped it up.",
  "There was a {piece} hanging on {sq}, ripe for the taking, but {san} looks elsewhere. {bestSan} was the grab.",
  "{bestSan} simply wins the {piece} on {sq}, and {san} passes it up instead.",
  "A free {piece} was sitting on {sq}, and {san} walked past it. {bestSan} takes it.",
];

// --- the "quiet" error: no single piece hangs ---------------------------------------

// The played move plus its idea, as the subject of "... loses material" / "... hands
// over the initiative". When there's no idea, commentary.js uses the bare SAN instead.
export const OPENER_WITH_IDEA = [
  "{san}, {idea},",
  "{san} ({idea})",
  "{san}, with the idea of {idea},",
  "{san}, intending {idea},",
];

export const LOSE_MATERIAL_VERB = [
  "loses material",
  "costs material",
  "gives material away",
  "drops material",
  "hands over material",
  "bleeds material",
  "spills material",
];

export const LOSE_MATERIAL_TEMPLATE = [
  "{opener} {verb}. {punish}",
  "{opener} {verb} here. {punish}",
  "{opener} {verb}, and it tells. {punish}",
];

// The forcing line's material count, named with the punishing reply. Standalone,
// capitalised sentences.
export const PUNISH_WITH_REPLY_COUNT = [
  "After {reply}, {tailComma}{opp} ends up {phrase} ahead.",
  "{opp} grabs it: {reply} nets {phrase}{tailParen}.",
  "After {reply}{tailDash}, {opp} comes away {phrase} up.",
  "Once {reply} lands, {opp} is {phrase} to the good{tailParen}.",
  "{opp} plays {reply} and is suddenly {phrase} up{tailParen}.",
  "After {reply}, {tailComma}{opp} is simply {phrase} to the good.",
];

export const PUNISH_NO_REPLY_COUNT = [
  "{opp} ends up {phrase} ahead in the line that follows.",
  "The position settles with {opp} {phrase} up.",
  "{opp} comes out {phrase} to the good from here.",
  "That's {phrase} gone, just like that.",
  "{opp} is left {phrase} up once the dust settles.",
];

// What the move costs when nothing is materially lost — initiative/tempo, by phase.
export const PHASE_HINT_OPENING = [
  "gives away precious development time",
  "loses a tempo in the opening",
  "lets the development lead slip",
  "costs a valuable opening tempo",
  "falls behind in development",
  "wastes a move the opening can't spare",
];
export const PHASE_HINT_MIDDLEGAME = [
  "hands over the initiative",
  "lets the initiative slip away",
  "gives up the momentum",
  "cedes the initiative",
  "loses the thread of the position",
  "lets the pressure drain away",
];
export const PHASE_HINT_ENDGAME = [
  "gives up a tempo the endgame can't spare",
  "loses precious time in the endgame",
  "costs a critical tempo here",
  "hands over the move that matters most",
  "lets a key tempo slip in the endgame",
  "wastes a vital tempo in the ending",
];

// The resulting standing, as a standalone capitalised sentence.
export const STANDING_TAIL = [
  "{opp} is now {standing}.",
  "That leaves {opp} {standing}.",
  "{opp}'s position is {standing} from here.",
  "{opp} comes away {standing}.",
  "{opp} is {standing} as a result.",
];

// With a named punishing reply (folded into a sentence, no dash).
export const INITIATIVE_WITH_PUNISH = [
  "{opener} {phaseHint}. {punishCap} {standingTail}",
  "{opener} {phaseHint}, and {punish} {standingTail}",
  "{opener} {phaseHint}. {punishCap} Now {opp} is {standing}.",
];

// No reply to name — the standing stands on its own.
export const INITIATIVE_NO_PUNISH = [
  "{opener} {phaseHint}. {standingTail}",
  "{opener} {phaseHint}, and that leaves {opp} {standing}.",
  "{opener} {phaseHint}, so {opp} is {standing} now.",
  "{opener} {phaseHint}. {standingTailCap}",
];

// The recommendation: what to play instead, and what it keeps/saves (via {merit}).
export const BETTER_MOVE = [
  "{bestSan} was the move{merit}.",
  "{bestSan} keeps things together{merit}.",
  "Instead, {bestSan}{merit}.",
  "{bestSan} was the way to go{merit}.",
  "Better was {bestSan}{merit}.",
  "{bestSan} holds it together{merit}.",
  "The clean path was {bestSan}{merit}.",
  "{bestSan} sidesteps all of it{merit}.",
  "Far safer was {bestSan}{merit}.",
  "{bestSan} was the one to play{merit}.",
];

// =====================================================================================
// Inaccuracy.
// =====================================================================================
export const INACC_HEAD_WITH_IDEA = [
  "{san} is a touch loose. The idea ({idea}) is fine, only it isn't the sharpest try.",
  "A shade inaccurate: {san}, {idea}, but there was something cleaner.",
  "{san} ({idea}) is reasonable, just not quite the most precise.",
  "Nothing's broken with {san}, {idea}, but it's a touch inaccurate.",
  "{san}, {idea}, is playable, though a hair imprecise.",
];

export const INACC_HEAD_PLAIN = [
  "A touch loose: {me} lets a little of the edge slip.",
  "Slightly inaccurate, no real harm done, just not the sharpest try.",
  "A small inaccuracy. The position's still fine, only a hair less precise.",
  "Not the sharpest, a small inaccuracy creeps in.",
  "A minor slip: {me} loses a touch of the edge.",
  "A shade imprecise, nothing serious.",
];

export const INACC_CLEANER = [
  " {bestSan} would have kept things tidier{payoff}.",
  " {bestSan} was a touch more precise{payoff}.",
  " {bestSan} kept a firmer grip{payoff}.",
  " A little sharper was {bestSan}{payoff}.",
  " {bestSan} held the edge better{payoff}.",
  " {bestSan} was the cleaner road{payoff}.",
];

// All entries say "edges ahead" (the inaccuracy-flip test checks for it).
export const INACC_FLIP = [
  " Now {opp} edges ahead, and {me} is {standing}.",
  " {opp} edges ahead from here, and {me} is {standing}.",
  " From here {opp} edges ahead, leaving {me} {standing}.",
  " {opp} edges ahead as a result, so {me} is {standing}.",
  " That lets {opp} edge ahead, and {me} is {standing}.",
];

// =====================================================================================
// Great — the only move, or a decisive winning blow.
// =====================================================================================
export const GREAT_DECISIVE = [
  "{san} is the strongest move on the board, and {me} comes out up {phrase}. Clean.",
  "Great. {san} snaps off {phrase}, and nothing else came close. Nicely done.",
  "Best of the bunch: {san} wins {phrase}, and only this move does it so cleanly.",
  "{san} is the killer blow, picking up {phrase} outright.",
  "That's the shot. {san} wins {phrase}, no question.",
  "{san} is decisive: {me} grabs {phrase} and the rest is academic.",
  "Crisp. {san} wins {phrase} and leaves {me} firmly on top.",
];

export const GREAT_ONLY_MOVE = [
  "Great find. {san} was the only move that holds everything together. Well spotted.",
  "Great move. {san} is the one move that keeps {me} afloat. Nicely found.",
  "The only move, and you found it. {san} is the lifeline here. That's how games get saved.",
  "{san}, and it's the only move. Everything else loses, this one survives.",
  "Superb. {san} was the single move that kept {me} in the game.",
  "Right on the only square. {san} is the one move that doesn't lose. Great find.",
  "Spot on. {san} is the lone path that holds, and you took it.",
];

// =====================================================================================
// Best / Good — standalone leads (no trailing dash); the gist follows as its own clause.
// =====================================================================================
export const LEAD_BEST = [
  "Good move.",
  "Nicely played.",
  "Solid.",
  "Well played.",
  "Spot on.",
  "That's the move.",
  "Strong choice.",
  "Good call.",
];
export const LEAD_GOOD = [
  "Looks fine.",
  "Reasonable.",
  "That works.",
  "Decent.",
  "Not bad.",
  "Fine choice.",
  "Sensible.",
  "Perfectly playable.",
];

export const POINT_MATERIAL = [
  " {me} is up {phrase} now.",
  " That puts {me} up {phrase}.",
  " {me} comes away up {phrase}.",
  " {me} banks {phrase} for the trouble.",
  " That's {phrase} in {me}'s pocket.",
];

export const POINT_TARGET = [
  " Now the {piece} on {sq} is feeling the heat.",
  " The {piece} on {sq} is in trouble now.",
  " That piles the pressure on the {piece} on {sq}.",
  " The {piece} on {sq} is a target now.",
  " The {piece} on {sq} has nowhere comfortable to go.",
];

export const POINT_ENDGAME = [
  " The extra {phrase} should tell in the endgame.",
  " That extra {phrase} matters a lot in an endgame like this.",
  " In an endgame, {phrase} extra is significant.",
  " That spare {phrase} is worth its weight in an ending.",
];

export const STAND_TAIL = [
  " {me} is {standing}.",
  " That keeps {me} {standing}.",
  " {me} remains {standing}.",
  " {me} stays {standing}.",
  " {me} holds firm and is {standing}.",
];

// A mild, honest "why" for a sound move with nothing flashy to point at — so even a
// quiet good move gets a word of explanation rather than a bare label.
export const GOOD_SOLID = [
  " It keeps the position simple and sound.",
  " Nothing fancy, just solid and safe.",
  " A clean, healthy move that keeps control.",
  " It keeps everything where it should be.",
  " Steady and sensible, no loose ends.",
  " It holds the position together nicely.",
];

// =====================================================================================
// Tactic threats CREATED by a strong move (leading space, full sentence).
// =====================================================================================
export const GOOD_THREAT_FORK = [
  " It forks {targets}, so one of them drops.",
  " That forks {targets}, and {opp} can't save both.",
  " Now {targets} are forked, and {me} wins one of them.",
  " A fork hits {targets} at once, and {opp} has to give one up.",
  " A fork on {targets}: {opp} saves one and loses the other.",
];

export const GOOD_THREAT_PIN = [
  " The {front} is pinned to the {back} and can't move.",
  " That pins the {front} to the {back}, freezing it in place.",
  " Now the {front} is pinned against the {back}.",
  " The {front} can't budge, pinned to the {back}.",
  " It pins the {front} to the {back}, and the pin bites.",
];

export const GOOD_THREAT_PIN_ABS = [
  " The {front} is pinned to the king and can't legally move.",
  " That nails the {front} to the king, dead pinned.",
  " Now the {front} is dead pinned to the king.",
  " The {front} is frozen, pinned to the king itself.",
  " An absolute pin: the {front} can't move at all.",
];

export const GOOD_THREAT_SKEWER = [
  " It skewers the {front}, and when it moves the {back} behind it falls.",
  " That lines up the {front} and the {back}, winning the one behind.",
  " The {front} has to move, and the {back} behind it drops.",
  " Now the {front} and {back} are skewered, and {opp} loses the back one.",
  " A skewer: the {front} steps aside and the {back} is lost.",
];

// =====================================================================================
// Tactic threats the move HANDS the opponent (leading space, full sentence).
// =====================================================================================
export const ERROR_OPP_THREAT_FORK = [
  " Worse, {opp} now forks {targets}.",
  " On top of that, {opp} forks {targets}.",
  " Now {opp} has a fork on {targets}.",
  " And {opp} can fork {targets} to boot.",
];

export const ERROR_OPP_THREAT_PIN = [
  " Worse, {opp} now pins the {front} to the {back}.",
  " On top of that, the {front} is pinned to the {back}.",
  " Now {opp} pins the {front} to the {back}.",
  " And the {front} is stuck, pinned to the {back}.",
];

export const ERROR_OPP_THREAT_PIN_ABS = [
  " Worse, the {front} is now pinned to the king.",
  " On top of that, {opp} pins the {front} to the king.",
  " Now the {front} is dead pinned to the king.",
  " And the {front} can't move, pinned to the king.",
];

export const ERROR_OPP_THREAT_SKEWER = [
  " Worse, {opp} skewers the {front} and wins the {back} behind it.",
  " On top of that, {opp} has a skewer on the {front} and {back}.",
  " Now {opp} skewers the {front}, and the {back} drops.",
  " And {opp} can skewer the {front} to win the {back}.",
];
