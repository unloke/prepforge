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
  "Checkmate. {san} leaves the king with nowhere to run.",
  "And it's mate. {san} closes the net for good.",
  "{san}. Checkmate, and the king has no escape.",
  "That settles it: {san} is checkmate.",
  "Mate it is. {san} ends the conversation.",
  "{san} is mate. No squares left, no defence, no game.",
  "Checkmate, plain as day. {san} does it.",
  "{san}, and the king is trapped. That's mate.",
];

// =====================================================================================
// Brilliant — grounded in the Maia/Stockfish disagreement.
// =====================================================================================
export const BRILLIANT_LEAD = [
  "Brilliant! Almost no one would find {san}, and you did. {looksCap} it's the best move on the board, and {me} stays {stand}.",
  "Brilliant. {san} is the kind of move you don't expect a person to find, but you found it. {looksCap} it's simply best, and {me} stays {stand}.",
  "Brilliant! {looksCap} {san} is exactly right, and you saw it, holding {me} {stand}.",
  "A real brilliancy, {san}. {looksCap} it's the only move that works, and you played it, leaving {me} {stand}.",
  "Brilliant! {san} is a move humans almost never find, and you did. {looksCap} it keeps {me} {stand}.",
  "That's brilliant. {looksCap} {san} turns out to be the best move on the board, and you spotted it, so {me} stays {stand}.",
  "Wow, {san} is brilliant. {looksCap} you got it exactly right, and {me} comes out {stand}.",
  "Brilliant move, {san}. {looksCap} it's the best there is, and you found it, keeping {me} {stand}.",
  "Brilliant find, {san}. {looksCap} it holds everything together, and {me} is {stand}.",
  "{san} is brilliant. {looksCap} nothing else even comes close, and you saw it, so {me} stays {stand}.",
  "Brilliant! {looksCap} {san} is precisely the move, and you found it, leaving {me} {stand}.",
  "A brilliant stroke, {san}. {looksCap} it is the one move that delivers, and you played it, so {me} stays {stand}.",
  "Brilliant! {looksCap} {san} is the hardest move to see here, and you saw it, so {me} is {stand}.",
  "That's a brilliancy. {looksCap} {san} works to perfection, and you found it, leaving {me} {stand}.",
  "Brilliant, {san}. {looksCap} it's the hidden best move, and you uncovered it, keeping {me} {stand}.",
  "Pure brilliance: {san}. {looksCap} it's the only road that holds, and you took it, so {me} stays {stand}.",
  "Brilliant! {san} is a move almost no one sees, and you did. {looksCap} it's best, and {me} is {stand}.",
  "What a move. {san} is brilliant: {looks} it's exactly right, and you found it, so {me} stays {stand}.",
  "Brilliant! {looksCap} {san} is the move to play here through and through, and you nailed it, so {me} is {stand}.",
  "A flash of brilliance, {san}. {looksCap} it's the truth of the position, and you saw it, so {me} stays {stand}.",
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
  "it looks like the {piece} is just given up, but",
  "every instinct says the {piece} is lost, but",
  "the {piece} looks left to its fate, but",
  "it reads as a {piece} thrown away, but",
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
  "it looks unremarkable at first, but",
  "you could easily play right past it, but",
  "nothing about it shouts brilliance, but",
  "it hides its intent completely, but",
];

// How rarely a human finds this — translated from Maia's policy probability. All
// entries say "players" (the Brilliant-grounding test checks for it).
export const RARITY_TIER1 = [ // maiaHumanProb < 0.01
  "virtually no human players would even consider it",
  "almost no players at the board would even look at it",
  "hardly any players would dare to play it",
  "next to no players would ever pick it",
  "you could show this to a thousand players and almost none would find it",
  "practically no players would even glance at this move",
  "all but a vanishing few players would walk straight past it",
  "it's the kind of move scarcely any players ever spot",
];
export const RARITY_TIER2 = [ // < 0.03
  "only about one in fifty players would try it",
  "only a tiny fraction of players would find it",
  "barely one in fifty players would go for it",
  "scarcely any players would choose it over the natural move",
  "perhaps one player in fifty would land on it",
  "only the sharpest-eyed players would even consider it",
  "a slim handful of players in fifty would commit to it",
  "very few players would back themselves to play it",
];
export const RARITY_TIER3 = [ // < 0.06
  "only a handful of players would go for it",
  "very few players would risk it",
  "only a small minority of players would try it",
  "not many players would trust it",
  "just a small share of players would pick it out",
  "few players would have the nerve to play it",
  "only a thoughtful minority of players would find it",
  "most players would never settle on it",
];
export const RARITY_TIER4 = [ // else
  "few players would risk it",
  "not many players would choose it",
  "relatively few players would play it",
  "most players would pass it by",
  "plenty of players would overlook it",
  "the majority of players would play something else",
  "more players would miss it than find it",
  "it's far from the move most players would reach for",
];

// The grounded "why": the rarity (capitalised, sentence-initial) plus the Maia/Stockfish
// gap. All entries name "players" and "Stockfish" (Brilliant-grounding test).
export const BRILLIANT_WHY = [
  "{rarityCap}. Most players would read this position as {maiaStand} for {me}, and you saw the move they'd all miss.",
  "{rarityCap}. To most players this looks {maiaStand} for {me}, yet you found the truth of it.",
  "{rarityCap}. To most players this looks {maiaStand} for {me}, and you saw further than they would.",
  "{rarityCap}, and to most players the position reads as {maiaStand} for {me}. You looked deeper.",
  "{rarityCap}. Where most players see {maiaStand} for {me}, you spotted the path almost no one finds.",
  "{rarityCap}. The human eye reads this as {maiaStand} for {me}, and you cut straight through it.",
  "{rarityCap}, because to most players it looks {maiaStand} for {me}. You knew otherwise.",
  "{rarityCap}. Most players would write the position off as {maiaStand} for {me}; you didn't, and you were right.",
  "{rarityCap}. Players see {maiaStand} for {me} at a glance, and you did the hard work to see past it.",
  "{rarityCap}, and the position looks {maiaStand} for {me} to nearly everyone. You found what they couldn't, and Stockfish confirms it.",
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
  "That's a blunder, no way around it.",
  "Trouble: that's a blunder.",
  "That one's a real misstep, a blunder.",
  "Unfortunately, that's a blunder.",
  "That hands over a lot: a blunder.",
  "A bad one, I'm afraid: a blunder.",
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
  "Not the one: that's a mistake.",
  "A misjudgement here, a mistake.",
  "That lets something slip, a mistake.",
  "Off the mark a bit, a mistake.",
  "That's a wrong turn, a mistake.",
  "A little loose there, that's a mistake.",
  "That one costs you, a mistake.",
];

// --- walking into a forced mate -------------------------------------------------
export const IN_MATE_NET = [
  "{san} walks into a forced mate. After {reply}, {extra}{opp} finishes by force.",
  "{san} allows a forced mate. After {reply}, {extra}{opp} mates from here.",
  "That's losing on the spot: {san} runs into a mating net, and after {reply}, {extra}{opp} finishes it.",
  "{san} steps right into mate. After {reply}, {extra}{opp} wraps it up by force.",
  "{san} hands over a forced mate. After {reply}, {extra}{opp} closes it out.",
  "Fatal: {san} walks into the mating net. After {reply}, {extra}{opp} forces the finish.",
  "{san} lets the king get mated. After {reply}, {extra}{opp} has it by force.",
];

// --- stepping past a forced mate -------------------------------------------------
export const MISSED_MATE = [
  "{me} walks straight past a forced mate. {bestSan} ended it on the spot.",
  "There was mate on the board and {me} missed it. {bestSan} would have finished the game.",
  "{bestSan} was mate, and {me} played something else instead.",
  "A forced mate was sitting right there with {bestSan}, and {me} let it go.",
  "{me} had mate in hand and passed it up. {bestSan} was curtains.",
  "Mate was on with {bestSan}, and {me} looked the other way.",
  "{me} let a forced mate slip. {bestSan} would have ended it cleanly.",
  "The finish was {bestSan}, a forced mate, and {me} stepped around it.",
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
  "{san} leaves the {piece} on {sq} there for the taking",
  "{san} hangs the {piece} on {sq}, plain and simple",
  "{san} lets the {piece} on {sq} drop with nothing in return",
  "{san} parks the {piece} on {sq} right in harm's way",
];

// Standalone, capitalised sentences (joined after the hang description with a period).
export const HANG_PUNISH_WITH_REPLY = [
  "After {reply}, {opp} is {standing}.",
  "Once {reply} lands, {opp} is {standing}.",
  "After {reply}, that leaves {opp} {standing}.",
  "{opp} grabs it with {reply} and is {standing} now.",
  "After {reply}, {opp}'s position turns {standing}.",
  "{opp} plays {reply} and is suddenly {standing}.",
  "After {reply}, {opp} takes over and is {standing}.",
  "{opp} snaps it up with {reply}, now {standing}.",
  "Once {reply} comes, {opp} is {standing} for it.",
];

export const HANG_PUNISH_NO_REPLY = [
  "{opp} is {standing} now.",
  "That leaves {opp} {standing}.",
  "{opp}'s position is {standing} as a result.",
  "{opp} ends up {standing}.",
  "From here {opp} is {standing}.",
  "{opp} is {standing} off the back of it.",
  "That hands {opp} a {standing} game.",
  "{opp} comes out of it {standing}.",
];

// --- missing a free piece / forced win --------------------------------------------
export const MISSED_WIN = [
  "{san} misses it: there was a free {piece} on {sq} going begging, and {bestSan} grabs it instead.",
  "{san} lets a free {piece} on {sq} slip away. {bestSan} would have scooped it up.",
  "There was a {piece} hanging on {sq}, ripe for the taking, but {san} looks elsewhere. {bestSan} was the grab.",
  "{bestSan} simply wins the {piece} on {sq}, and {san} passes it up instead.",
  "A free {piece} was sitting on {sq}, and {san} walked past it. {bestSan} takes it.",
  "The {piece} on {sq} was there for nothing, but {san} leaves it. {bestSan} collects it.",
  "{san} overlooks a loose {piece} on {sq}. {bestSan} would have pocketed it.",
  "There for free on {sq} was the {piece}, and {san} left it standing. {bestSan} grabs it.",
];

// --- the "quiet" error: no single piece hangs ---------------------------------------

// The played move plus its idea, as the subject of "... loses material" / "... hands
// over the initiative". When there's no idea, commentary.js uses the bare SAN instead.
export const OPENER_WITH_IDEA = [
  "{san}, {idea},",
  "{san}, {idea},",
  "{san}, with the idea of {idea},",
  "{san}, intending {idea},",
  "{san}, the point being {idea},",
  "{san}, idea: {idea},",
];

export const LOSE_MATERIAL_VERB = [
  "loses material",
  "costs material",
  "gives material away",
  "drops material",
  "hands over material",
  "bleeds material",
  "spills material",
  "sheds material",
  "leaks material",
  "concedes material",
];

export const LOSE_MATERIAL_TEMPLATE = [
  "{opener} {verb}. {punish}",
  "{opener} {verb} here. {punish}",
  "{opener} {verb}, and it tells. {punish}",
  "{opener} {verb} along the way. {punish}",
  "{opener} {verb} in the process. {punish}",
  "{opener} quietly {verb}. {punish}",
  "{opener} doesn't solve the tactics. {punish}",
  "{opener} lets the exchange settle the wrong way. {punish}",
  "{opener} walks into a poor trade. {punish}",
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
  "{reply} does the damage: {opp} is {phrase} up{tailParen}.",
  "After {reply}, {tailComma}{opp} walks off {phrase} ahead.",
  "Once {reply} hits, {tailComma}{opp} banks {phrase}.",
  "{reply} clears it up, and the trade leaves {opp} with {phrase}.",
  "The point is {reply}: after that, {opp} has won {phrase}.",
  "After {reply}, {tailComma}the material story is {phrase} for {opp}.",
];

export const PUNISH_NO_REPLY_COUNT = [
  "{opp} ends up {phrase} ahead in the line that follows.",
  "The position settles with {opp} {phrase} up.",
  "{opp} comes out {phrase} to the good from here.",
  "That's {phrase} gone, just like that.",
  "{opp} is left {phrase} up once the dust settles.",
  "The line runs out with {opp} {phrase} ahead.",
  "When it all settles, {opp} is {phrase} to the good.",
  "{opp} pockets {phrase} out of it.",
  "The trade resolves as {phrase} for {opp}.",
  "Once the dust clears, {opp} has taken {phrase}.",
  "The resulting exchange favours {opp} by {phrase}.",
];

// What the move costs when nothing is materially lost — initiative/tempo, by phase.
export const PHASE_HINT_OPENING = [
  "gives away precious development time",
  "loses a tempo in the opening",
  "lets the development lead slip",
  "costs a valuable opening tempo",
  "falls behind in development",
  "wastes a move the opening can't spare",
  "surrenders the early initiative",
  "lets the opponent catch up in development",
  "spends a tempo the opening needed",
];
export const PHASE_HINT_MIDDLEGAME = [
  "hands over the initiative",
  "lets the initiative slip away",
  "gives up the momentum",
  "cedes the initiative",
  "loses the thread of the position",
  "lets the pressure drain away",
  "passes the initiative across the board",
  "lets the momentum change hands",
  "loosens the grip on the position",
  "lets the pressure ease off",
];
export const PHASE_HINT_ENDGAME = [
  "gives up a tempo the endgame can't spare",
  "loses precious time in the endgame",
  "costs a critical tempo here",
  "hands over the move that matters most",
  "lets a key tempo slip in the endgame",
  "wastes a vital tempo in the ending",
  "burns a tempo the ending sorely needs",
  "lets a decisive tempo go in the endgame",
];

// The resulting standing, as a standalone capitalised sentence.
export const STANDING_TAIL = [
  "{opp} is now {standing}.",
  "That leaves {opp} {standing}.",
  "{opp}'s position is {standing} from here.",
  "{opp} comes away {standing}.",
  "{opp} is {standing} as a result.",
  "{opp} stands {standing} now.",
  "That tips it: {opp} is {standing}.",
];

// With a named punishing reply (folded into a sentence, no dash).
export const INITIATIVE_WITH_PUNISH = [
  "{opener} {phaseHint}. {punishCap} {standingTail}",
  "{opener} {phaseHint}, and {punish} {standingTail}",
  "{opener} {phaseHint}. {punishCap} Now {opp} is {standing}.",
  "{opener} {phaseHint}. {punishCap} {opp} is {standing} for it.",
  "{opener} {phaseHint}, so {punish} {standingTail}",
];

// No reply to name — the standing stands on its own.
export const INITIATIVE_NO_PUNISH = [
  "{opener} {phaseHint}. {standingTail}",
  "{opener} {phaseHint}, and that leaves {opp} {standing}.",
  "{opener} {phaseHint}, so {opp} is {standing} now.",
  "{opener} {phaseHint}. {standingTailCap}",
  "{opener} {phaseHint}, and {opp} is {standing} for it.",
  "{opener} {phaseHint}. From here {opp} is {standing}.",
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
  "{bestSan} was cleaner{merit}.",
  "The move was {bestSan}{merit}.",
  "{bestSan} kept it simple{merit}.",
  "You wanted {bestSan}{merit}.",
  "{bestSan} steers clear of trouble{merit}.",
];

// =====================================================================================
// Inaccuracy.
// =====================================================================================
// NB: no parentheses around {idea} — they read as machine-generated footnotes; fold the
// idea in with commas instead.
export const INACC_HEAD_WITH_IDEA = [
  "{san} is a touch loose. The idea, {idea}, is fine, only it isn't the sharpest try.",
  "A shade inaccurate: {san}, {idea}, but there was something cleaner.",
  "{san}, {idea}, is reasonable, just not quite the most precise.",
  "Nothing's broken with {san}, {idea}, but it's a touch inaccurate.",
  "{san}, {idea}, is playable, though a hair imprecise.",
  "{san}, {idea}, is sound enough, only it isn't the most exact.",
  "No harm in {san}, {idea}, though there was a crisper option.",
  "{san}, {idea}, does the job, just not as cleanly as it could.",
];

export const INACC_HEAD_PLAIN = [
  "A touch loose: {me} lets a little of the edge slip.",
  "Slightly inaccurate, no real harm done, just not the sharpest try.",
  "A small inaccuracy. The position's still fine, only a hair less precise.",
  "Not the sharpest, a small inaccuracy creeps in.",
  "A minor slip: {me} loses a touch of the edge.",
  "A shade imprecise, nothing serious.",
  "A little imprecise, but the position holds for {me}.",
  "Slightly off the mark, though nothing's really lost.",
  "Just a hair loose from {me}, no damage done.",
  "A small imprecision, easy to put right.",
];

export const INACC_CLEANER = [
  " {bestSan} would have kept things tidier{payoff}.",
  " {bestSan} was a touch more precise{payoff}.",
  " {bestSan} kept a firmer grip{payoff}.",
  " A little sharper was {bestSan}{payoff}.",
  " {bestSan} held the edge better{payoff}.",
  " {bestSan} was the cleaner road{payoff}.",
  " {bestSan} was a shade more exact{payoff}.",
  " {bestSan} would have squeezed a bit more{payoff}.",
  " A touch better was {bestSan}{payoff}.",
];

// The opponent's strong reply to an inaccuracy, named with what it does — the concrete "why"
// behind "this wasn't the sharpest" ("...because Ne5 hits the queen and improves the knight").
// {tail} is the reply's idea, already lowercased and comma-shaped.
export const INACC_PUNISH = [
  " {opp} gets to play {reply}, {tail}.",
  " It lets {opp} in with {reply}, {tail}.",
  " {opp} can answer {reply}, {tail}.",
  " Now {opp} has {reply}, {tail}.",
  " {opp} replies {reply}, {tail}.",
];

// All entries say "edges ahead" (the inaccuracy-flip test checks for it).
export const INACC_FLIP = [
  " Now {opp} edges ahead, and {me} is {standing}.",
  " {opp} edges ahead from here, and {me} is {standing}.",
  " From here {opp} edges ahead, leaving {me} {standing}.",
  " {opp} edges ahead as a result, so {me} is {standing}.",
  " That lets {opp} edge ahead, and {me} is {standing}.",
  " It's enough that {opp} edges ahead, with {me} {standing}.",
  " Just like that {opp} edges ahead, and {me} is {standing}.",
];

// =====================================================================================
// Forced — there was exactly one legal move. Nothing to find, nothing to fault; the
// rules left no choice. Never praise this as a "find". {stand} is the resulting standing.
// =====================================================================================
export const FORCED_MOVE = [
  "Forced. {san} is the only legal move on the board.",
  "No choice here: {san} is the only legal move.",
  "{san} is forced, the only legal move available.",
  "This one plays itself: {san} is the only legal move.",
  "Nothing to decide, {san} is the only legal move.",
  "{san}, the only legal move in the position.",
  "Forced move: {san} was the one and only legal option.",
  "Hands tied: {san} is the only legal move here.",
  "{san} is forced, with no other legal move to weigh.",
  "Only one way to go: {san} is the only legal move.",
];

// Forced specifically because the king was in check — one legal way to meet it.
export const FORCED_CHECK = [
  "Forced. {san} is the only legal reply to the check.",
  "The only way to meet the check is {san}.",
  "{san} is forced, the only legal escape from check.",
  "No choice: {san} is the one move that answers the check.",
  "In check with one way out: {san}.",
  "{san}, the only legal response to the check.",
  "Check, and {san} is the only legal way to answer it.",
  "Only one way out of check: {san}.",
  "{san} is forced here, the lone legal reply to the check.",
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
  "{san} is the hammer blow, taking {phrase} off the board.",
  "Clean and decisive: {san} wins {phrase} and that's that.",
  "{san} lands it, scooping up {phrase} for {me}.",
  "Textbook. {san} wins {phrase}, and nothing else was close.",
];

// The "only move that holds" — kept matter-of-fact. These often fire on a forced-feeling
// recapture or the lone legal-ish reply, so the wording states the fact ("this was the one
// move that holds") without the breathless "that's how games get saved / brilliant find"
// hype, which jarred when the move was the obvious or near-forced one.
export const GREAT_ONLY_MOVE = [
  "{san} was the only move that holds things together, and you played it.",
  "{san} is the one move that keeps {me} afloat, and you found it.",
  "Important: {san} was the only move here, the rest let it slip.",
  "{san}, and it's the only move. Everything else loses, this one survives.",
  "{san} was the single move that keeps {me} in the game.",
  "{san} is the one move that doesn't lose, and you played it.",
  "{san} is the lone move that holds, and you took it.",
  "{san} is the only move that holds the line, and you found it.",
  "The one saving move was {san}, and you didn't miss it.",
  "Only {san} keeps {me} standing, and that's what you played.",
  "{san} was the one move that holds; the rest fall apart.",
];

// A "Great"/"only move" that is really just a forced-feeling RECAPTURE or even trade — taking
// the wood back is the one move that holds, but the breathless "you found the saving move!"
// hype jarred ("save 了什麼鬼"). State it plainly: it's a recapture, and it was the only move
// that kept things level.
export const GREAT_RECAPTURE = [
  "{san} takes the material back, and it's the one move that keeps {me} level.",
  "{san} recaptures, the only move that holds the balance.",
  "{san} wins the piece back, the cleanest way to stay even.",
  "{san} is the recapture, and the only move here that doesn't lose ground.",
  "{san} takes it back; anything else would have let the edge slip.",
  "{san} is the necessary recapture, and you played it.",
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
  "Right idea.",
  "Cleanly done.",
  "That's the one.",
  "Good judgement.",
  "Exactly right.",
  "Well chosen.",
  "Nicely judged.",
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
  "That holds up.",
  "Sound enough.",
  "Nothing wrong with that.",
  "A fair move.",
  "That'll do.",
  "Steady.",
  "Reasonable enough.",
];

export const POINT_MATERIAL = [
  " {me} is up {phrase} now.",
  " That puts {me} up {phrase}.",
  " {me} comes away up {phrase}.",
  " {me} banks {phrase} for the trouble.",
  " That's {phrase} in {me}'s pocket.",
  " {me} pockets {phrase} from it.",
  " That nets {me} {phrase}.",
  " {me} is {phrase} to the good now.",
  " The material count now favours {me} by {phrase}.",
  " That trade leaves {me} with {phrase} in hand.",
  " {me} gets the better side of the exchange: {phrase}.",
];

// A clean, even trade (a capture the settled count says nets nothing) — narrated
// honestly as a swap, never as "winning a pawn". This is what the exchange-resolved
// material read buys us: a recaptured trade no longer pretends to be a material gain.
export const POINT_TRADE = [
  " It trades pieces and keeps the position simple.",
  " That swaps a pair off, easing any pressure.",
  " A clean trade, nothing lost on either side.",
  " It exchanges pieces and simplifies toward a clearer game.",
  " Pieces come off evenly, which keeps things tidy.",
  " A fair swap that takes the sting out of the position.",
  " An even exchange that clears the air a little.",
  " It swaps a pair off without ceding anything.",
  " Pieces trade off and the position breathes easier.",
];

// A trade made while ahead — simplification is the right idea, so say so.
export const POINT_TRADE_AHEAD = [
  " Trading while ahead is the right idea, steering toward a won ending.",
  " With {me} ahead, swapping pieces brings the win closer.",
  " A good trade: fewer pieces favours the side with more, and that's {me}.",
  " Exchanging down suits {me}, who is the one ahead on material.",
  " Simplifying while ahead is sound, and {me} is the one ahead.",
  " Fewer pieces on the board helps {me}, who holds the material edge.",
  " A welcome swap: trading down plays to {me}'s extra material.",
];

// NB: kept to honest "under pressure / has to move" wording. The old "nowhere comfortable to
// go" / "in trouble" / "in the crosshairs" lines over-claimed — a pawn kicking a knight that
// has perfectly good retreats isn't trapping it, it's putting the question to it.
export const POINT_TARGET = [
  " Now the {piece} on {sq} is feeling the heat.",
  " The {piece} on {sq} is under pressure now.",
  " That piles pressure on the {piece} on {sq}.",
  " The {piece} on {sq} is a target now.",
  " The {piece} on {sq} has to find a square.",
  " The {piece} on {sq} is put to the question.",
  " That leans on the {piece} on {sq}.",
  " The {piece} on {sq} has to watch its step.",
];

export const POINT_ENDGAME = [
  " The extra {phrase} should tell in the endgame.",
  " That extra {phrase} matters a lot in an endgame like this.",
  " In an endgame, {phrase} extra is significant.",
  " That spare {phrase} is worth its weight in an ending.",
  " The extra {phrase} is the kind of edge that decides endings.",
  " {phrase} to the good carries real weight in the endgame.",
];

export const STAND_TAIL = [
  " {me} is {standing}.",
  " That keeps {me} {standing}.",
  " {me} remains {standing}.",
  " {me} stays {standing}.",
  " {me} holds firm and is {standing}.",
  " {me} is sitting {standing}.",
  " That leaves {me} {standing}.",
  " {me} keeps {standing}.",
];

// A mild, honest "why" for a sound move with nothing flashy to point at — so even a
// quiet good move gets a word of explanation rather than a bare label.
// Kept SHORT and humble. We're here only because nothing concrete (a capture, threat,
// target, mate) was found to point at, so a brief "solid, no weaknesses" is honest — but
// the long, self-important variants ("maintains a healthy, comfortable position", "keeps
// the plan coherent and avoids unnecessary weaknesses") read as padding and drew the most
// "nothing-burger" complaints, so they're gone.
export const GOOD_SOLID = [
  " Solid and sound.",
  " Nothing fancy, just safe.",
  " A clean, healthy move.",
  " Steady, no loose ends.",
  " It holds things together.",
  " A tidy, sound move.",
  " No fuss, just useful.",
  " Sensible and solid.",
];

// A sound move played from a clearly worse position — the move is fine, but the position
// isn't, so the tone acknowledges the disadvantage instead of praising it as "solid".
// Uses {me}, {opp}, {standing} (the mover's qualitative standing, e.g. "clearly worse").
export const GOOD_HOLD = [
  " {me} is {standing} here, but this is the toughest way to hold it together.",
  " It won't undo the damage, {me} is {standing}, but it's the best practical try.",
  " {me} is {standing}, and this is about the best the position has to offer.",
  " The position is difficult for {me}, but this keeps fighting for it.",
  " It makes {opp} work for the win, with {me} {standing}.",
  " Best under the circumstances. {me} is {standing}, but this puts up the most resistance.",
  " {me} is {standing}, so this is damage control, and good damage control at that.",
  " A difficult spot for {me}, {standing} here, but this is the most stubborn defence.",
  " {me} is {standing}, yet this is the practical choice that fights on the longest.",
  " Hard going for {me} at {standing}, though this keeps the most resistance alive.",
  " {me} is {standing}, but this is the toughest nut for {opp} to crack.",
];

// A sound move from a position that was ALREADY lost before it — so we neither praise it as
// "solid" (oblivious) nor restate "you're clearly worse" yet again (the user already knows,
// and the harping wore thin). Just a neutral nod to its being the toughest practical try, with
// NO standing word.
export const GOOD_HOLD_QUIET = [
  " It's the most resilient try here.",
  " This puts up the stiffest resistance.",
  " About the best practical chance.",
  " The toughest defence on offer.",
  " It keeps the game as hard as possible for the other side.",
  " A sensible, stubborn choice.",
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
  " It catches {targets} in a fork, and one has to fall.",
  " A fork catches both {targets} at once, and {opp} can only rescue one.",
  " That forking blow on {targets} wins one of them.",
];

export const GOOD_THREAT_PIN = [
  " The {front} is pinned to the {back} and can't move.",
  " That pins the {front} to the {back}, freezing it in place.",
  " Now the {front} is pinned against the {back}.",
  " The {front} can't budge, pinned to the {back}.",
  " It pins the {front} to the {back}, and the pin bites.",
  " The {front} is tied down, pinned to the {back}.",
  " The {front} is clamped in a pin to the {back}, stuck fast.",
  " With the {front} pinned to the {back}, it isn't going anywhere.",
];

export const GOOD_THREAT_PIN_ABS = [
  " The {front} is pinned to the king and can't legally move.",
  " That nails the {front} to the king, dead pinned.",
  " Now the {front} is dead pinned to the king.",
  " The {front} is frozen, pinned to the king itself.",
  " An absolute pin: the {front} can't move at all.",
  " The {front} is glued to the king, unable to move a square.",
  " Pinned to the king, the {front} is completely stuck.",
];

export const GOOD_THREAT_SKEWER = [
  " It skewers the {front}, and when it moves the {back} behind it falls.",
  " That lines up the {front} and the {back}, winning the one behind.",
  " The {front} has to move, and the {back} behind it drops.",
  " Now the {front} and {back} are skewered, and {opp} loses the back one.",
  " A skewer: the {front} steps aside and the {back} is lost.",
  " The {front} is skewered, and the {back} behind it can't be saved.",
  " Once the {front} shifts, the {back} behind it falls.",
];

// =====================================================================================
// Tactic threats the move HANDS the opponent (leading space, full sentence).
// =====================================================================================
export const ERROR_OPP_THREAT_FORK = [
  " Worse, {opp} now forks {targets}.",
  " On top of that, {opp} forks {targets}.",
  " Now {opp} has a fork on {targets}.",
  " And {opp} can fork {targets} to boot.",
  " Worse still, {opp} lands a fork on {targets}.",
  " To make it sting, {opp} forks {targets}.",
];

export const ERROR_OPP_THREAT_PIN = [
  " Worse, {opp} now pins the {front} to the {back}.",
  " On top of that, the {front} is pinned to the {back}.",
  " Now {opp} pins the {front} to the {back}.",
  " And the {front} is stuck, pinned to the {back}.",
  " Worse still, {opp} pins the {front} to the {back}.",
  " And now the {front} is tied to the {back} by a pin.",
];

export const ERROR_OPP_THREAT_PIN_ABS = [
  " Worse, the {front} is now pinned to the king.",
  " On top of that, {opp} pins the {front} to the king.",
  " Now the {front} is dead pinned to the king.",
  " And the {front} can't move, pinned to the king.",
  " Worse still, the {front} is nailed to the king.",
  " And the {front} is frozen, pinned to the king.",
];

export const ERROR_OPP_THREAT_SKEWER = [
  " Worse, {opp} skewers the {front} and wins the {back} behind it.",
  " On top of that, {opp} has a skewer on the {front} and {back}.",
  " Now {opp} skewers the {front}, and the {back} drops.",
  " And {opp} can skewer the {front} to win the {back}.",
  " Worse still, {opp} skewers the {front} and the {back} falls.",
  " And a skewer on the {front} costs the {back} behind it.",
];

// =====================================================================================
// Intuition — the position's "texture" from Maia's human-move distribution, crossed with
// Stockfish's verdict. These are trailing, capitalised sentences (a leading space) folded
// onto the end of the move's commentary. {obviousSan} is the human-obvious move; {san} the
// move actually played. See intuition.js for how each case is selected.
// =====================================================================================

// An error in an OBVIOUS position where the natural move was also best — reads as a slip
// of the hand or a momentary lapse, not a real misjudgement.
export const INTUITION_SLIP = [
  " This was a natural spot, and {obviousSan} is almost everyone's move here, so it looks more like a slip than a real misread.",
  " In a position this clear, {obviousSan} plays itself, so this reads like a momentary lapse rather than a misjudgement.",
  " Most players find {obviousSan} on autopilot here, which makes this look like a slip of the hand.",
  " {obviousSan} was the natural, obvious choice, so going astray feels like a brief lapse in focus.",
  " The position pointed straight at {obviousSan}, so this looks like a slip rather than a genuine misread.",
  " Almost everyone plays {obviousSan} on instinct here, so chalk this one up to a momentary slip.",
  " This was an intuitive position where {obviousSan} stands out, so it has the feel of a careless slip.",
  " {obviousSan} is the move that leaps out here, which makes this look like a lapse rather than a real error of judgement.",
  " With {obviousSan} so obvious, this comes across as a slip more than a misunderstanding.",
  " {obviousSan} is what instinct grabs here, so this reads as a slip rather than a misread.",
  " The natural {obviousSan} practically plays itself, so chalk this up to a momentary lapse.",
  " Nearly everyone reaches for {obviousSan} on autopilot, which makes this look like a slip.",
  " {obviousSan} was right there on instinct, so this feels like a lapse more than a real misjudgement.",
];

// An error in a RICH position — several plausible moves, no single obvious one. A hard
// place to go wrong, so the read is sympathetic rather than scolding.
export const INTUITION_HARD = [
  " To be fair, this is a rich, double-edged position with several tempting tries, so it's an easy place to go wrong.",
  " In fairness, the position is complex with a lot of reasonable-looking moves, so it's a hard one to get right.",
  " This was a genuinely tricky spot, with several candidate moves pulling in different directions.",
  " The position is sharp and full of options, so missing the best one here is understandable.",
  " It's a demanding position with no single obvious move, so this is a forgivable place to stumble.",
  " There were several plausible tries here, so this rich position made the right path hard to see.",
  " This is a knotty, double-edged position, the kind where even strong players go astray.",
  " With so many tempting moves on the board, this was a hard position to navigate cleanly.",
  " No shame in this one: the position bristles with options and the right move was well hidden.",
  " A sharp, many-sided position where the best move hides easily.",
  " This was a complex spot with several candidates, so a wrong turn here is forgivable.",
  " The position is tricky and double-edged, the kind that trips up even careful players.",
  " A demanding, knotty position, so missing the cleanest path is no surprise.",
];

// A strong move that ISN'T the human-obvious one, in an otherwise obvious position — you
// took the road less travelled and it works.
export const INTUITION_OWN_PATH = [
  " Most players would reach for {obviousSan} here; you found a less obvious route in {san} that's every bit as strong.",
  " The natural move was {obviousSan}, but {san} is a quieter path to the same end. Nicely seen.",
  " Where most would play {obviousSan}, you chose the less travelled {san}, and it holds up well.",
  " {obviousSan} was the obvious try; {san} is the road less taken, and it works just as well.",
  " A creative choice: most reach for {obviousSan}, but {san} gets there by a different route.",
  " You sidestepped the natural {obviousSan} for {san}, an equally sound idea with its own flavour.",
  " Interesting: {obviousSan} is what most would play, yet {san} is just as good and rather more original.",
  " Few would pass up {obviousSan}, but {san} is an inventive way to the same result.",
  " Most hands play {obviousSan}; you took the quieter path with {san}, and it lands.",
  " {obviousSan} is the well-trodden move, but {san} is the road less travelled and just as sound.",
  " A creative turn: where {obviousSan} is natural, {san} sidestepped it to the same strong end.",
];

// The human-obvious move was NOT best, and you played the engine's best instead — you saw
// past the tempting natural move (a small trap dodged).
export const INTUITION_AVOIDED = [
  " Note that the instinctive {obviousSan} isn't best here; you saw past it to {san}.",
  " The natural-looking {obviousSan} falls short, and {san} is the stronger, less obvious choice you found.",
  " Many would play the tempting {obviousSan}, but {san} is sharper, and you spotted it.",
  " {obviousSan} is what the position seems to ask for, yet {san} is better, and you didn't take the bait.",
  " You resisted the obvious {obviousSan} and played the stronger {san} instead. Well judged.",
  " The eye goes to {obviousSan}, but it isn't best; {san} is, and you found it.",
  " Good discipline: {obviousSan} is the natural move and the inferior one, while {san} is the real best.",
  " It would be easy to play {obviousSan} on instinct, but {san} is the better move, and you saw it.",
  " You didn't take the bait of {obviousSan}, finding the stronger {san} instead.",
  " {obviousSan} is the natural-but-inferior try, and you saw past it to {san}.",
  " Many would grab the obvious {obviousSan}, yet you resisted and played the better {san}.",
];

// A sound move in a RICH position — well-chosen among many tempting tries.
export const INTUITION_RICH_HANDLED = [
  " This was a rich position with several candidate moves, and {san} is a strong pick among them.",
  " A complex spot with lots of plausible tries, and you landed on a good one in {san}.",
  " The position offered many tempting moves, and {san} steers a sound course through them.",
  " In a double-edged position full of options, {san} keeps you on the right side of things.",
  " Plenty of reasonable moves here, and {san} is one of the best of them.",
  " A sharp, many-sided position, navigated well with {san}.",
  " There was a lot to weigh here, and {san} is a confident, healthy choice.",
  " The board was full of candidates, and {san} is a clear-headed pick.",
  " A tangle of options here, and {san} cuts through them cleanly.",
  " Lots to consider, and {san} is a calm, well-judged answer.",
  " The position pulled in several directions, and {san} keeps a steady hand.",
];

// A sound move that IS the human-obvious one — natural and correct. Kept mild so an
// everyday recapture isn't over-praised.
export const INTUITION_NATURAL = [
  " The natural move, and the right one.",
  " That's the move the position calls for, played without fuss.",
  " The obvious choice here, and a sound one.",
  " Exactly what most would play, and correctly so.",
  " The intuitive move, and it holds up.",
  " Straightforward and correct, just as the position suggests.",
  " The move that plays itself, and it's the right one.",
  " The natural choice, and there's nothing better to find.",
  " Just what the position asks for, played without fuss.",
  " The obvious move here, and rightly so.",
];

// =====================================================================================
// Intent — the quiet, strategic POINT of a move that wins nothing and forces nothing.
// Slotted below the concrete tactics/material points, above the generic "sound move" line.
// =====================================================================================

// DEFEND — a friendly piece stayed put but is now safely covered.
export const INTENT_DEFEND = [
  " It shores up the {piece} on {sq}.",
  " That defends the {piece} on {sq}.",
  " Now the {piece} on {sq} is properly covered.",
  " It takes care of the loose {piece} on {sq}.",
  " The {piece} on {sq} is safe again.",
  " That props up the {piece} on {sq}.",
  " It gives the {piece} on {sq} the support it needed.",
  " The {piece} on {sq} is no longer hanging.",
];

// DEFEND — the threatened piece itself stepped out of danger.
export const INTENT_DEFEND_AWAY = [
  " It gets the {piece} out of the firing line.",
  " That tucks the {piece} away from danger.",
  " The {piece} slips out of harm's way.",
  " It saves the {piece} before it could be taken.",
  " That moves the {piece} to safety.",
  " The {piece} steps clear of the threat.",
  " It rescues the {piece} just in time.",
  " That gets the {piece} off a sore square.",
];

// OPEN LINE — clears a diagonal or file for a friendly bishop/rook/queen.
export const INTENT_OPEN_LINE = [
  " It opens {line} for the {piece}.",
  " That clears {line} for the {piece}.",
  " Now the {piece} has {line} to itself.",
  " It frees {line} for the {piece} to bite.",
  " The {piece} springs to life along {line}.",
  " That lets the {piece} breathe down {line}.",
  " It hands the {piece} an open {line}.",
  " Now {line} is the {piece}'s highway.",
];

// PROPHYLAXIS — removes a tactic the opponent had been threatening.
export const INTENT_PROPHYLAXIS = [
  " It takes the sting out of the {stopped}.",
  " That snuffs out the {stopped} before it could land.",
  " The {stopped} is off the table now.",
  " It quietly defuses the {stopped}.",
  " That shuts the door on the {stopped}.",
  " No more {stopped} to worry about.",
  " It heads off the {stopped} in good time.",
  " The threatened {stopped} is dealt with.",
];

// TRADE — offers an even swap of equal pieces.
export const INTENT_TRADE = [
  " It offers a trade of {piece}s.",
  " That puts a {piece} swap on the table.",
  " It invites the {piece} trade.",
  " A {piece} trade is on offer.",
  " It proposes swapping the {piece}s off.",
  " That angles for a {piece} exchange.",
];

// TRADE while ahead — simplifying toward a won game.
export const INTENT_TRADE_AHEAD = [
  " It offers to swap {piece}s, simplifying while ahead.",
  " Trading {piece}s here is exactly right with the extra material.",
  " It invites the {piece} trade, and fewer pieces favour the side that's up.",
  " A {piece} swap suits {me} just fine with material in the bank.",
  " That offers the {piece} trade, the classic way to convert an edge.",
  " Swapping {piece}s eases the win along.",
];

// KING ATTACK — a wing pawn storming the castled king.
export const INTENT_KING_STORM = [
  " It gets the pawn storm rolling against the king.",
  " That pawn joins the attack on the king.",
  " The pawns start rolling at the enemy king.",
  " It cracks open the air around the king.",
  " That's the storm beginning on the king's doorstep.",
  " The pawn advance leans on the king's cover.",
];

// KING ATTACK — a piece lifting into the king's quadrant.
export const INTENT_KING_PIECE = [
  " It swings a piece toward the enemy king.",
  " That brings another attacker into the king's zone.",
  " The piece joins the hunt around the king.",
  " It points fresh fire at the king.",
  " That adds weight to the attack on the king.",
  " Another piece arrives near the king.",
];

// AVOID TRADE — a major piece sidesteps an offered swap, keeping the heavy pieces on.
export const INTENT_AVOID_TRADE = [
  " It declines the {piece} trade and keeps the pieces on.",
  " That sidesteps the {piece} swap, keeping more pieces on the board.",
  " It dodges the {piece} exchange to keep the tension.",
  " Rather than swap, it keeps the {piece}s on.",
  " It steps the {piece} aside instead of trading.",
  " That keeps the {piece}s on, declining the offered swap.",
];

// FIANCHETTO — the bishop reaching its long-diagonal post.
export const INTENT_FIANCHETTO = [
  " The bishop takes up the fianchetto on {sq}, raking the long diagonal.",
  " That fianchettoes the bishop on {sq}, eyeing the long diagonal.",
  " The bishop settles on {sq}, the long diagonal now its own.",
  " It completes the fianchetto, the bishop on {sq} biting down the long diagonal.",
  " The fianchettoed bishop on {sq} sweeps the long diagonal.",
  " That puts the bishop on {sq}, its best post on the long diagonal.",
];

// FIANCHETTO PREP — a wing pawn step clearing the way for the bishop.
export const INTENT_FIANCHETTO_PREP = [
  " It clears the way to fianchetto the bishop.",
  " That prepares the fianchetto for the bishop.",
  " It opens the door for the bishop to fianchetto.",
  " The pawn step sets up the fianchetto.",
  " That readies the bishop's fianchetto.",
];

// CENTER — a bishop centralised on a strong square.
export const INTENT_CENTER = [
  " It centralises the bishop on {sq}.",
  " The bishop takes a strong central post on {sq}.",
  " That plants the bishop in the centre on {sq}.",
  " The bishop sits proudly in the centre on {sq}.",
  " It stakes out the centre with the bishop on {sq}.",
];

// CENTER — a knight on a central outpost (the most pressing of the centralisers).
export const INTENT_CENTER_KNIGHT = [
  " The knight lands on a commanding central outpost on {sq}.",
  " It plants the knight on {sq}, a dominant central square.",
  " The knight on {sq} is a monster in the middle of the board.",
  " That posts the knight on {sq}, right in the heart of the position.",
  " The knight digs into the centre on {sq}, cramping everything around it.",
  " It parks the knight on the strong central square {sq}, and it won't be easy to budge.",
];

// DEVELOP — a back-rank minor coming into play.
export const INTENT_DEVELOP = [
  " It develops the {piece}, bringing a fresh piece into the game.",
  " That gets the {piece} into play.",
  " The {piece} comes off the back rank and into the game.",
  " It brings the {piece} out, another piece in the fight.",
  " A healthy developing move, the {piece} joining the action.",
  " That puts the {piece} to work.",
  " The {piece} gets into the game, just what the opening asks for.",
  " It mobilises the {piece}, building toward a finished setup.",
];

// DEVELOP — a rook claiming an open or half-open file.
export const INTENT_DEVELOP_ROOK = [
  " The rook takes the {openFile} {file}-file.",
  " It swings the rook onto the {openFile} {file}-file.",
  " That activates the rook down the {openFile} {file}-file.",
  " The rook claims the {openFile} {file}-file, eyeing straight down it.",
  " It plants the rook on the {openFile} {file}-file.",
  " The rook seizes the {openFile} {file}-file.",
];

// CENTER STRIKE — a pawn challenging an enemy pawn in the centre.
export const INTENT_CENTER_STRIKE = [
  " It challenges the centre, striking at the pawn on {sq}.",
  " That hits back at the centre, putting the question to the {sq} pawn.",
  " It contests the centre by striking the {sq} pawn.",
  " The push challenges the {sq} pawn and fights for the centre.",
  " It strikes at the centre pawn on {sq}.",
  " That puts the {sq} pawn under question and stakes a claim in the centre.",
];

// SPACE — a central pawn advancing into the opponent's half, taking squares away. {squares}
// is a ready-made phrase ("the c6 and e6 squares" / "the d6 square" / "space").
export const INTENT_SPACE = [
  " It grabs space and takes {squares} away from {opp}.",
  " It gains space, clamping down on {squares}.",
  " It stakes out space, denying {opp} {squares}.",
  " That seizes space and takes {squares} from {opp}.",
  " It cramps {opp}, with a firm grip on {squares}.",
  " It claims central space, controlling {squares}.",
];

// PRESSURE — a heavy piece trains fire on an enemy base pawn (a single attacker).
export const INTENT_PRESSURE = [
  " It leans on the {sq} pawn.",
  " It brings the {piece} to bear on the {sq} pawn.",
  " That trains fire on the {sq} pawn.",
  " It puts the {sq} pawn under pressure.",
  " The {sq} pawn comes under fire.",
  " It eyes the {sq} pawn.",
];

// PRESSURE (reinforced) — a second heavy piece joins the attack on the base pawn (a battery
// doubling on the file). The "Rb8 reinforces the threat on b2" the bare "rook takes the
// b-file" line was missing.
export const INTENT_PRESSURE_REINFORCE = [
  " It doubles up on the {file}-file, piling pressure on the {sq} pawn.",
  " It reinforces the pressure on the {sq} pawn.",
  " That stacks another attacker on the {sq} pawn.",
  " It joins the attack on the {sq} pawn, doubling on the {file}-file.",
  " More weight comes down on the {sq} pawn.",
  " It adds a second attacker to the {sq} pawn.",
];

// SUPPORT — a move that adds a defender to a friendly pawn under attack (incl. a king
// covering an advanced pawn).
export const INTENT_SUPPORT = [
  " It shores up the {sq} pawn.",
  " That adds a defender to the {sq} pawn.",
  " It covers the {sq} pawn.",
  " The {sq} pawn is properly held now.",
  " It backs up the {sq} pawn under fire.",
  " That props up the attacked {sq} pawn.",
];

// RECAPTURE — a capture that wins back material the opponent had just taken, levelling
// the count (named honestly as "taking back", never as a fresh material gain).
export const POINT_RECAPTURE = [
  " It takes the {piece} back, squaring the material.",
  " That recaptures the {piece}, restoring the balance.",
  " It wins the {piece} back, and the material is level again.",
  " The {piece} comes straight back, evening the count.",
  " That's the recapture, the {piece} restored and the material level.",
  " It recovers the {piece}, keeping the material even.",
];

// PAWN PRESSURE — a quiet move that leans on a loose enemy pawn.
export const POINT_PAWN_PRESSURE = [
  " It leans on the pawn on {sq}.",
  " That puts the pawn on {sq} under pressure.",
  " The pawn on {sq} is feeling the heat now.",
  " It eyes the loose pawn on {sq}.",
  " That piles pressure on the {sq} pawn.",
  " The {sq} pawn is awkward to defend now.",
];

// PAWN PRESSURE — a move that hits two loose enemy pawns at once.
export const POINT_PAWN_DOUBLE = [
  " It attacks both loose pawns, on {sq1} and {sq2}.",
  " That hits two undefended pawns at once, {sq1} and {sq2}.",
  " Both the {sq1} and {sq2} pawns come under fire, and one must fall.",
  " It forks the loose pawns on {sq1} and {sq2}.",
  " The {sq1} and {sq2} pawns are both hanging now, and only one can be saved.",
];

// A short "still, the position is what it is" tag appended after a positive idea when the
// mover is nonetheless clearly worse — so the encouragement doesn't ignore the scoreboard,
// but we lead with the constructive idea instead of harping on the disadvantage. Each entry
// names the standing (so the "worse"-position test still sees it).
export const GOOD_HOLD_TAG = [
  " Even so, {me} is {standing}.",
  " It won't change that {me} is {standing}, but it's the right way to keep fighting.",
  " {me} is still {standing}, yet this keeps the most resistance.",
  " The position stays {standing} for {me}, but this is the way to scrap on.",
];
