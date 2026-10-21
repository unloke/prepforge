// Exercise the rendered layout while async Coach/Humans/prep states change.
// The content is a deterministic geometry fixture, not a Maia prediction.
export async function checkAnalyzeStability(page, phone, check) {
  const selectors = ['#analysis-explain', '#analysis-eval-graph', '#analysis-board', '#view-analyze .board-bar'];
  if (phone) selectors.push('#analysis-engine-slot');
  const saved = await page.evaluate(() => {
    const humans = document.getElementById('coach-maia'), prep = document.getElementById('coach-bookline');
    return { prose: document.getElementById('coach-prose').textContent,
      humans: { hidden: humans.hidden, html: humans.innerHTML }, prep: { hidden: prep.hidden, text: prep.textContent } };
  });
  await page.evaluate(selectors => {
    window.__analysisLayoutProbe = { frames: [], active: true };
    const frame = () => {
      const probe = window.__analysisLayoutProbe;
      probe.frames.push(selectors.map(selector => {
        const rect = document.querySelector(selector).getBoundingClientRect();
        return { selector, top: rect.top, height: rect.height, width: rect.width };
      }));
      if (probe.active) requestAnimationFrame(frame);
    };
    frame();
  }, selectors);
  for (let i = 0; i < 6; i++) {
    await page.evaluate(i => {
      const humans = document.getElementById('coach-maia'), prep = document.getElementById('coach-bookline');
      humans.hidden = i % 2 === 0;
      humans.innerHTML = '<span class="hp-label">Humans</span><button type="button" class="hp"><b>Nf3</b><span class="hp-pct">64%</span></button><button type="button" class="hp"><b>Bb5+</b><span class="hp-pct">36%</span></button>';
      prep.hidden = i < 3;
      prep.textContent = i < 3 ? '' : 'In your preparation · Open repertoire';
      document.getElementById('coach-prose').textContent = i % 2 === 0 ? 'The knight develops.' : 'The knight attacks the queen and protects the bishop. The reply keeps the rook defended while the king moves out of check.';
      if (i === 2 || i === 4) document.getElementById('open-engine-widget').click();
    }, i);
    await page.waitForTimeout(100);
  }
  const measurements = await page.evaluate(() => {
    const probe = window.__analysisLayoutProbe;
    probe.active = false;
    return probe.frames[0].map((entry, index) => {
      const ranges = {};
      for (const key of ['top', 'height', 'width']) {
        const values = probe.frames.map(frame => frame[index][key]);
        ranges[key] = Math.max(...values) - Math.min(...values);
      }
      return { selector: entry.selector, ...ranges };
    });
  });
  for (const row of measurements) {
    check(row.top <= 1 && row.height <= 1 && row.width <= 1,
      `async Coach/Humans/prep and engine states must keep ${row.selector} stable: ${JSON.stringify(row)}`);
  }
  await page.evaluate(saved => {
    document.getElementById('coach-prose').textContent = saved.prose;
    const humans = document.getElementById('coach-maia'), prep = document.getElementById('coach-bookline');
    humans.hidden = saved.humans.hidden; humans.innerHTML = saved.humans.html;
    prep.hidden = saved.prep.hidden; prep.textContent = saved.prep.text;
  }, saved);
}
