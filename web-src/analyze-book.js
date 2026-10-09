import { html } from "./html.js";
// Analyze's repertoire cache and departure actions load with the view.
export function createBookActions({
  bookState, appState, currentOwnerId, api, loadCoach, rememberHandoff, postJson, setStatus, setStatusError, editRepertoire,
}) {
async function ensureBookLoaded() {
  if (bookState.loaded) return;
  if (bookState.loading) return bookState.loading;
  const generation = bookState.generation;
  const owner = currentOwnerId();
  bookState.loading = (async () => {
    let reps = [];
    try {
      const payload = await api("/api/repertoires");
      const active = (payload.repertoires || []).filter(
        (r) => r.is_active !== false && !appState.pendingRepDeletes.has(String(r.id))
      );
      reps = (
        await Promise.all(
          active.map(async (meta) => {
            const data = await api(
              `/api/build/load?repertoire_id=${encodeURIComponent(meta.id)}`
            );
            const children = new Map();
            const kids = new Map();
            let rootId = null;
            for (const node of data.nodes || []) {
              if (!node.parent_id) {
                rootId = node.id;
                continue;
              }
              if (node.is_enabled === false || !node.uci) continue;
              children.set(`${node.parent_id}|${node.uci}`, node);
              if (!kids.has(node.parent_id)) kids.set(node.parent_id, []);
              kids.get(node.parent_id).push(node);
            }
            return rootId
              ? { id: data.repertoire_id, name: data.name, color: data.color, rootId, children, kids }
              : null;
          })
        )
      ).filter(Boolean);
    } catch (_) {
      /* guest / fetch failure → no book; the banner simply stays hidden */
    }
    if (generation !== bookState.generation || owner !== currentOwnerId()) return;
    bookState.reps = reps;
    bookState.loaded = true;
    bookState.loading = null;
  })();
  return bookState.loading;
}

// Deepest full-prefix match of `ucis` across the loaded repertoires.
// Returns { rep, node, matched } for the best rep, or null when none loaded.
function bookMatch(ucis) {
  let best = null;
  for (const rep of bookState.reps) {
    let cur = rep.rootId;
    let node = null;
    let matched = 0;
    for (const uci of ucis) {
      const child = rep.children.get(`${cur}|${uci}`);
      if (!child) break;
      node = child;
      cur = child.id;
      matched += 1;
    }
    if (!best || matched > best.matched) best = { rep, node, nodeId: cur, matched };
  }
  return best;
}

// The uci path from the analysis-tree root down to `node` (mainline or variation).
function analysisNodePath(node) {
  const path = [];
  for (let cur = node; cur && cur.parent; cur = cur.parent) path.push(cur.uci);
  return path.reverse();
}

function hideBookline() {
  const el = document.getElementById("coach-bookline");
  if (el) {
    el.hidden = true;
    el.innerHTML = "";
  }
}

// Called on every Analyze position change (via refreshAnalysisExplain). Async and
// best-effort: the first call kicks off the lazy load and re-renders when it lands.
//
// The departure note is part of the coach's CONVERSATION, not a status widget:
// while the line is in book, nothing is shown (the screen only carries what's
// useful right now); at the exact ply a move steps out of the book, the coach
// adds one sentence from the bookline phrase bank, with the single useful
// action (train the forgotten move / add the novelty in Build) as an inline
// chip at the end of the sentence, like a spoken link.
async function updateBookline() {
  const el = document.getElementById("coach-bookline");
  if (!el) return;
  if (!appState.signedIn) return hideBookline();
  const { buildBookline } = await loadCoach();
  const nodeId = appState.analysisCurrentNodeId || "root";
  await ensureBookLoaded();
  // Re-read after the await — the user may have navigated while the trees loaded.
  if ((appState.analysisCurrentNodeId || "root") !== nodeId) return;
  if (!bookState.reps.length) return hideBookline();
  const tree = appState.analysisTree;
  const node = tree && tree.byId.get(nodeId);
  if (!node || !node.parent) return hideBookline(); // root: nothing played yet
  const path = analysisNodePath(node);
  const cur = bookMatch(path);
  // Still in book: the coach has nothing to flag, so it says nothing.
  if (cur && cur.matched === path.length) return hideBookline();
  // Out of book. Only speak at the departure ply: the PARENT was fully in book.
  // When the parent position sits in SEVERAL books, prefer the repertoire where
  // the mover is the player — forgetting your own prep outranks a novelty note.
  const prefix = path.slice(0, -1);
  const fullPrev = bookState.reps
    .map((rep) => {
      let walk = rep.rootId;
      for (const uci of prefix) {
        const child = rep.children.get(`${walk}|${uci}`);
        if (!child) return null;
        walk = child.id;
      }
      return { rep, nodeId: walk };
    })
    .filter(Boolean);
  if (!fullPrev.length) return hideBookline();
  const prev = fullPrev.find((m) => node.side === m.rep.color) || fullPrev[0];
  const rep = prev.rep;
  const moverIsUser = node.side === rep.color;

  if (moverIsUser) {
    // The player left their own prep: say what the script wanted, offer to drill it.
    const prescribed = (rep.kids.get(prev.nodeId) || [])
      .sort((a, b) => Number(b.is_mainline) - Number(a.is_mainline))[0];
    if (!prescribed) return hideBookline(); // book actually ends here — no miss
    const text = buildBookline({
      kind: "user",
      san: node.san,
      uci: node.uci,
      ply: path.length,
      repName: rep.name,
      expectedSan: prescribed.san,
    });
    el.innerHTML =
      html`${`${text} `}<button class="coach-bookaction" type="button" data-act="train">Add to training</button>`;
    el.hidden = false;
    el.querySelector('[data-act="train"]').addEventListener("click", async (event) => {
      const btn = event.currentTarget;
      btn.disabled = true;
      // F-06: keep the task context across the jump — source line, the ply and
      // anchor FEN of the mistake, the side and target repertoire — so the
      // later practice lands on this exact position and the mistake→practice
      // time is measurable. Same target = same key = one record, however often
      // the button is clicked.
      rememberHandoff({
        source: "analyze",
        reason: "practice-missed-move",
        gameId: appState.analysis?.game_id || null,
        lineUcis: [...prefix, prescribed.uci],
        ply: path.length,
        anchorFen: node.fenBefore,
        rootFen: appState.analysis?.moves?.[0]?.fen_before || null,
        side: rep.color,
        repertoireId: rep.id,
      });
      try {
        await postJson("/api/train/record-miss", {
          repertoire_id: rep.id,
          node_id: prescribed.id,
        });
        btn.textContent = "Added ✓";
        setStatus(`${prescribed.san} will lead your next smart session`);
      } catch (error) {
        btn.disabled = false;
        setStatusError(error.message);
      }
    });
  } else {
    // Opponent novelty: nothing to recall — offer to extend the book instead.
    const text = buildBookline({
      kind: "opponent",
      san: node.san,
      uci: node.uci,
      ply: path.length,
      repName: rep.name,
    });
    el.innerHTML =
      html`${`${text} `}<button class="coach-bookaction" type="button" data-act="build">Add it to repertoire<span class="cba-arrow" aria-hidden="true">›</span></button>`;
    el.hidden = false;
    el.querySelector('[data-act="build"]').addEventListener("click", () => {
      // F-06: Analyze→Repertoire handoff — the novelty line + anchor position
      // travel with the jump into Build.
      rememberHandoff({
        source: "analyze",
        reason: "extend-book",
        gameId: appState.analysis?.game_id || null,
        lineUcis: [...prefix, node.uci],
        ply: path.length,
        anchorFen: node.fenBefore,
        rootFen: appState.analysis?.moves?.[0]?.fen_before || null,
        side: rep.color,
        repertoireId: rep.id,
      });
      editRepertoire(rep.id, prev.nodeId);
    });
  }
}

  return { ensureBookLoaded, updateBookline };
}
