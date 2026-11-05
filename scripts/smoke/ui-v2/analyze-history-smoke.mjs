// Keep stale ready rows visible while a queued drawer refresh begins. Keyboard
// recall must activate the refreshed row, not focus a row about to be removed.
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { openAnalysisHistory } from "./analyze-history.mjs";

const browser = await chromium.launch({ headless: true });
try {
  for (const phone of [false, true]) {
    const page = await browser.newPage();
    await page.route("http://history.test/**", async (route) => {
      if (new URL(route.request().url()).pathname === "/api/analyses") {
        return route.fulfill({ contentType: "application/json", body: '{"analyses":[{"game_id":"fresh"}]}' });
      }
      return route.fulfill({ contentType: "text/html", body: `<!doctype html>
        <div id="view-analyze"><button data-sheet-open="analyze-open" aria-expanded="false" style="display:${phone ? "block" : "none"}">Games</button></div>
        <div id="analyze-open"><button data-reveal="#history-drawer" style="display:${phone ? "block" : "none"}">Recent analyses</button>
        <details id="history-drawer"><summary>History</summary><div id="analysis-history" aria-busy="false"><div class="history-item" data-game-id="old"><button class="hi-open">Old row</button></div></div></details></div>
        <script>
          const drawer = document.getElementById('history-drawer');
          const list = document.getElementById('analysis-history');
          document.querySelector('[data-sheet-open]').onclick = (e) => e.currentTarget.setAttribute('aria-expanded', 'true');
          document.querySelector('[data-reveal]').onclick = () => { drawer.open = true; };
          drawer.addEventListener('toggle', () => {
            if (!drawer.open) return;
            // Expose the interval between opening and the refresh's busy state.
            setTimeout(async () => {
              list.setAttribute('aria-busy', 'true');
              await (await fetch('/api/analyses')).json();
              list.innerHTML = '<div class="history-item" data-game-id="fresh"><button class="hi-open">Fresh row</button></div>';
              list.querySelector('button').onclick = () => { document.body.dataset.recalled = 'fresh'; };
              list.setAttribute('aria-busy', 'false');
            }, 100);
          });
        </script>` });
    });
    await page.goto("http://history.test/");
    await openAnalysisHistory(page);
    assert.equal(await page.locator(".history-item").getAttribute("data-game-id"), "fresh");
    await page.locator(".hi-open").press("Enter");
    assert.equal(await page.locator("body").getAttribute("data-recalled"), "fresh");
    await page.close();
  }
  console.log("[analyze-history-smoke] queued desktop/phone refreshes retain keyboard recall");
} finally { await browser.close(); }
