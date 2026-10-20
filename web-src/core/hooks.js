// Seams between the core modules and the lazily loaded views. A view that owns a
// repaint registers it here when it is created, so a shared setting change reaches
// it without the core importing the view (or the shell knowing every view).
export const hooks = {
  // Settings is open: repaint its theme control / strength controls.
  settingsPainted: null,
  strengthPainted: null,
  // A preference changed; Build repaints the inspector when it shows Coverage.
  prefApplied: null,
  // The account controller exists; setStatus routes a 401 through it.
  authRequired: null,
  // Build's Explorer row-eval worker (sync retargets the search, repaint
  // rewrites the Eval column).
  explorerEvals: null,
  // The live Analyze session (the engine widget hands it its snapshot).
  analyzeSession: null,
  // The Build view, its session and the Coverage panel: created lazily by the
  // shell, read by build-entry.js's tree/queue code.
  build: null,
};
