// Dashboard tab rendering (lazy-loaded from app.js).

function bindDropZone(element, onFile) {
  if (!element) return;
  const stop = (event) => {
    event.preventDefault();
    event.stopPropagation();
  };
  ["dragenter", "dragover"].forEach((type) =>
    element.addEventListener(type, (event) => {
      stop(event);
      element.classList.add("drag-over");
    }),
  );
  ["dragleave", "dragend"].forEach((type) =>
    element.addEventListener(type, (event) => {
      stop(event);
      element.classList.remove("drag-over");
    }),
  );
  element.addEventListener("drop", (event) => {
    stop(event);
    element.classList.remove("drag-over");
    const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
    if (file) onFile(file);
  });
}

export function createDashboardView({
  appState,
  api,
  postJson,
  escapeHtml,
  setStatus,
  localDateString,
  goToSmartTraining,
  editRepertoire,
  openRepertoireContextMenu,
  createRepertoirePrompt,
  hydrateBuild,
  showInputModal,
  promptImportRepertoireFromPgn,
  requireSignIn,
}) {
  let eventsBound = false;

  function healthBadgeHtml(health) {
    // The list carries a cached health badge (refreshed off Build/train, no per-row tree
    // walk). It is null until the rep is first opened/trained — then just omit the badge.
    if (!health) return "";
    if (!health.trainable) {
      return '<span class="rep-health rep-health-empty">no moves yet</span>';
    }
    const parts = [];
    if (health.weak) {
      parts.push(
        `<span class="rh-weak" title="Missed more often than answered">${health.weak} weak</span>`,
      );
    }
    if (health.due) {
      parts.push(`<span class="rh-due" title="Spaced repetition: review now">${health.due} due</span>`);
    }
    if (health.untrained) {
      parts.push(
        `<span class="rh-untrained" title="Never trained yet">${health.untrained} new</span>`,
      );
    }
    const pct = health.mastery_pct || 0;
    const tier = pct >= 80 ? "high" : pct >= 40 ? "mid" : "low";
    return (
      `<span class="rep-health">` +
      `<span class="rh-pct tier-${tier}" title="Mastered moves: recalled correctly 3+ times with no recent misses (${health.mastered}/${health.trainable})">${pct}% mastered</span>` +
      (parts.length ? `<span class="rh-detail">${parts.join(" · ")}</span>` : "") +
      `</span>`
    );
  }

  function renderDashboardToday(payload) {
    const card = document.getElementById("dashboard-today");
    if (!card) return;
    const streak = payload.streak || { current: 0, best: 0, trained_today: false };
    const due = payload.due_reviews || 0;
    const soon = payload.due_soon || 0;
    if (!payload.repertoires) {
      card.hidden = true;
      return;
    }
    const note = streak.trained_today
      ? `Trained today - day ${streak.current} ✓`
      : streak.current > 0
        ? `Train today to keep your ${streak.current}-day streak`
        : "Train today to start a streak";
    let warningHtml = "";
    if (!streak.trained_today && streak.current > 0) {
      const now = new Date();
      const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      const msLeft = midnight - now;
      if (msLeft < 5 * 60 * 60 * 1000) {
        const h = Math.floor(msLeft / 3600000);
        const m = Math.floor((msLeft % 3600000) / 60000);
        const left = h > 0 ? `${h}h ${m}m` : `${m}m`;
        warningHtml = `<div class="today-warning" role="alert">⏰ ${left} left to keep your ${streak.current}-day streak — one card is enough</div>`;
      }
    }
    const best = streak.best > 1 ? ` &middot; best ${streak.best}` : "";
    const queueBits = [];
    if (due > 0) queueBits.push(`<b>${due}</b> due now`);
    if (soon > 0) queueBits.push(`<b>${soon}</b> coming up in 24h`);
    const queueText = queueBits.length ? queueBits.join(" &middot; ") : "Queue is clear";
    const recap = payload.recap || null;
    let recapHtml = "";
    if (recap && (recap.reviews_7d > 0 || recap.mastered_now > 0 || recap.weak_now > 0)) {
      const delta = (n, goodWhenUp) => {
        if (!n) return "";
        const cls = (n > 0) === goodWhenUp ? "up" : "down";
        return ` <span class="${cls}">(${n > 0 ? "+" : ""}${n})</span>`;
      };
      const bits = [
        `<b>${recap.reviews_7d}</b> review${recap.reviews_7d === 1 ? "" : "s"} this week`,
        `<b>${recap.mastered_now}</b> <span title="Recalled correctly 3+ times with no recent misses - reviews days apart">mastered</span>${delta(recap.mastered_delta, true)}`,
      ];
      if (recap.weak_now > 0 || recap.weak_delta !== 0) {
        bits.push(
          `<b>${recap.weak_now}</b> <span title="Missed more often than answered">weak spot${recap.weak_now === 1 ? "" : "s"}</span>${delta(recap.weak_delta, false)}`,
        );
      }
      recapHtml = `<div class="today-recap">${bits.join(" &middot; ")}</div>`;
    }
    card.innerHTML = `
    <div class="today-streak" data-lit="${streak.current > 0 ? "1" : "0"}"
         title="Day streak: calendar days in a row (your local time) with at least one graded training move. One card a day keeps it alive.">
      <span class="today-flame" aria-hidden="true">\u{1F525}</span>
      <span class="today-count">${streak.current}</span>
      <span class="today-unit">day streak${best}</span>
    </div>
    <div class="today-text">
      ${warningHtml || `<div class="today-note">${note}</div>`}
      <div class="today-queue">${queueText}</div>
      ${recapHtml}
    </div>
    <button class="btn primary" id="dashboard-train-now" data-testid="dashboard-train-now">Train now</button>
  `;
    card.hidden = false;
    document.getElementById("dashboard-train-now").addEventListener("click", () =>
      goToSmartTraining(due > 0 ? "Due review - press Start to train" : "Press Start to train"),
    );
  }

  async function loadDashboardRepertoires() {
    const container = document.getElementById("dashboard-repertoires");
    try {
      if (appState.signedIn && !appState.teams.length) {
        try {
          const teamsPayload = await api("/api/teams");
          appState.teams = teamsPayload.teams || [];
        } catch (_) {
          /* team names for share badges are optional */
        }
      }
      const payload = await api("/api/repertoires");
      const visible = (payload.repertoires || []).filter(
        (item) => !appState.pendingRepDeletes.has(String(item.id)),
      );
      if (!visible.length) {
        container.innerHTML =
          '<div class="empty-state">No repertoires yet. Use Build to create one.</div>';
        return;
      }
      container.innerHTML = visible
        .map((item) => {
          const id = escapeHtml(item.id);
          const name = escapeHtml(item.name);
          const color = escapeHtml(item.color);
          const active = item.is_active !== false;
          const cls = active ? "list-item" : "list-item is-disabled";
          const status = active ? "" : ' <span class="sub">· disabled</span>';
          const team =
            item.visibility === "team" && item.team_id
              ? appState.teams.find((tm) => tm.id === item.team_id)
              : null;
          const shareBadge =
            item.visibility === "team" && item.team_id
              ? ` <span class="team-role-badge sm" title="Shared with ${escapeHtml(team ? team.name : "team")}">shared</span>`
              : "";
          return `
          <div class="${cls}" role="button" tabindex="0" data-repertoire-id="${id}" data-active="${active ? "1" : "0"}">
            <span>
              <span class="color-dot ${color}"></span>
              <span class="name">${name}</span>
              <span class="sub"> · ${color}</span>${status}${shareBadge}
            </span>
            ${healthBadgeHtml(item.health)}
            <button type="button" class="ib row-menu-btn" data-row-menu="${id}" title="Actions (train · rename · share · delete)" aria-haspopup="menu">⋯</button>
          </div>
        `;
        })
        .join("");
      container.querySelectorAll(".list-item").forEach((row) => {
        const open = () => editRepertoire(row.dataset.repertoireId);
        row.addEventListener("click", (event) => {
          if (event.target.closest(".row-menu-btn")) return;
          open();
        });
        row.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            open();
          }
        });
        row.addEventListener("contextmenu", (event) =>
          openRepertoireContextMenu(event, row.dataset.repertoireId, row.dataset.active === "1"),
        );
      });
      container.querySelectorAll(".row-menu-btn").forEach((btn) => {
        btn.addEventListener("click", (event) => {
          event.stopPropagation();
          const row = btn.closest(".list-item");
          const rect = btn.getBoundingClientRect();
          openRepertoireContextMenu(
            { preventDefault: () => {}, clientX: rect.left, clientY: rect.bottom + 4 },
            row.dataset.repertoireId,
            row.dataset.active === "1",
          );
        });
      });
    } catch (error) {
      container.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    }
  }

  async function loadDashboard() {
    const payload = await api(`/api/dashboard?local_date=${localDateString()}`);
    if (payload.streak) appState.dayStreak = payload.streak;
    renderDashboardToday(payload);
    const due = payload.due_reviews || 0;
    const metrics = [
      ["Games", payload.games, ""],
      ["Repertoires", payload.repertoires, ""],
      ["Sessions", payload.training_sessions, ""],
      ["Due review", due, due > 0 ? "is-due is-clickable" : ""],
    ];
    document.getElementById("dashboard-metrics").innerHTML = metrics
      .map(
        ([label, value, cls]) => `
        <div class="metric ${cls}" ${cls.includes("is-due") ? 'data-action="due-review"' : ""}>
          <div class="metric-value">${value}</div>
          <div class="metric-label">${label}</div>
        </div>
      `,
      )
      .join("");
    const dueMetric = document.querySelector('#dashboard-metrics [data-action="due-review"]');
    if (dueMetric) {
      dueMetric.addEventListener("click", () =>
        goToSmartTraining("Due review - press Start to train"),
      );
    }
    await loadDashboardRepertoires();
    setStatus("Ready");
  }

  async function dashboardImportPgn() {
    if (!requireSignIn("Sign in (or create an account) to import a repertoire")) return;
    const input = document.getElementById("dashboard-import-input");
    input.value = "";
    input.click();
  }

  async function handleImportPgnFile(file) {
    if (!requireSignIn("Sign in (or create an account) to import a repertoire")) return;
    if (!file) return;
    let text;
    try {
      text = await file.text();
    } catch (_) {
      setStatus("Could not read file");
      return;
    }
    const isJson = file.name.toLowerCase().endsWith(".json") || text.trim().startsWith("{");
    if (isJson) {
      try {
        const payload = await postJson("/api/repertoires/import", { package_json: text });
        await hydrateBuild(payload, payload.selected_node_id);
        appState.trainingRepertoireId = payload.repertoire_id;
        await loadDashboardRepertoires();
        setStatus(`Imported ${payload.name}`);
      } catch (error) {
        setStatus(error.message);
      }
      return;
    }
    try {
      await promptImportRepertoireFromPgn(text, {
        defaultName: file.name.replace(/\.[^.]+$/, ""),
      });
    } catch (_) {
      /* status already set */
    }
  }

  function bind() {
    if (eventsBound) return;
    eventsBound = true;

    const newRepBtn = document.getElementById("dashboard-new-rep");
    if (newRepBtn) {
      newRepBtn.addEventListener("click", () =>
        createRepertoirePrompt({ title: "New repertoire" }),
      );
    }

    const importBtn = document.getElementById("dashboard-import-pgn");
    if (importBtn) {
      importBtn.addEventListener("click", () => dashboardImportPgn().catch(() => {}));
    }

    const importInput = document.getElementById("dashboard-import-input");
    if (importInput) {
      importInput.addEventListener("change", (event) => {
        handleImportPgnFile(event.target.files && event.target.files[0]).catch(() => {});
      });
    }

    const dashCard = document.getElementById("dashboard-repertoires");
    bindDropZone(dashCard && dashCard.closest(".card"), (file) => {
      handleImportPgnFile(file).catch(() => {});
    });
  }

  return {
    bind,
    loadDashboard,
    loadDashboardRepertoires,
    renderDashboardToday,
    healthBadgeHtml,
  };
}