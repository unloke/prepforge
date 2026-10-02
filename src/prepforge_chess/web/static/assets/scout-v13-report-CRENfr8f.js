import{t as e}from"./chess-DwBov9dY.js";import{l as t,s as n,t as r}from"./scout-v13-package-Cf3cjdsU.js";var i={solid:`穩健`,sharp:`尖銳`,rare:`冷門`,forcing:`強迫`},a={ThinSample:`樣本偏少`,CohortOnly:`僅分段資料`,Narrow:`窄路線`,HighVariance:`高變異`,LowTheory:`理論偏少`,Transposes:`可轉入`},o={personal:`個人`,cohort:`同分段`,engine:`引擎`};function s(e){return String(e||``).replace(/[^a-zA-Z0-9_-]/g,``)}function c(e){let t=Number(e);return Number.isFinite(t)?`${t>=0?`+`:``}${t}`:`—`}function l(e){let t=Number(e);return Number.isFinite(t)?`${(t*100).toFixed(1)}%`:`—`}function u(t,n,r){if(!t?.length)return r(`—`);try{let i=new e,a=[];for(let e of n||[]){let n=i.move({from:e.slice(0,2),to:e.slice(2,4),promotion:e[4]||void 0});if(!n||(a.push(n.san),a.length>=t.length))break}return r(a.join(` `))}catch{return r((t||[]).join(` `))}}function d(e){return e.san||e.uci||`?`}function f(e,t){return`<span class="scout-v13-src scout-v13-src-${s(e)}">${t(o[e]||e)}</span>`}function p(e,t){let n=e.receipts||{};return t(`同分段對局中常見回應(${t(String(n.ratingBand||`—`))} ${t(String(n.speed||`—`))}, ${Number(n.explorerGames)||0} 局)`)}function m(e,t){let n=c(e.receipts?.evalCp);return e.receipts?.gapToBestCp!=null&&Number.isFinite(e.receipts.gapToBestCp)?t(`引擎建議(${n}cp, gap ${c(e.receipts.gapToBestCp)})`):t(`引擎建議(${n}cp)`)}function h(e,t){return t(`他的對局中此路徑出現 ${Number(e.receipts?.games)||0} 次`)}function g(e,t){return e.evidenceSource===`cohort`?p(e,t):e.evidenceSource===`engine`?e.receipts?.gapToBestCp!=null&&Number(e.receipts?.evalCp)>=0?t(`引擎戰術回應`):m(e,t):h(e,t)}function _(e,t){let n=e.receipts||{},r=Number(n.wins)||0,i=Number(n.draws)||0,a=Number(n.losses)||0,o=Number(n.games)||r+i+a;return o?`<span class="scout-v13-wdl">${t(`${r}W/${i}D/${a}L`)} <span class="scout-v13-games">n=${Number(o)}</span></span>`:``}function v(e,t,n=!1){let r=n?` scout-v13-edge-faded`:``,i=e.evidenceSource===`engine`&&e.receipts?.evalCp!=null?`<span class="scout-v13-eval-check">${t(c(e.receipts.evalCp))}cp</span>`:``;return`<div class="scout-v13-edge scout-v13-edge-ext${r}">
    ${f(e.evidenceSource,t)}
    <span class="scout-v13-san">${t(d(e))}</span>
    ${i}
    <span class="scout-v13-edge-note">${g(e,t)}</span>
  </div>`}function y(e,t){return`<div class="scout-v13-edge scout-v13-edge-trunk">
    <span class="scout-v13-san">${t(d(e))}</span>
    ${_(e,t)}
  </div>`}function b(e,n,r){let o=e.primaryStyle,c=o?s(`scout-v13-style-${o}`):`scout-v13-style-none`,d=o?i[o]||o:`—`,f=u(e.entryUcis,e.trunkUcis,n),p=l(e.trunk?.reachLB),m=Number(e.trunk?.personalAnchorPly)||0,h=(e.riskTags||[]).map(e=>`<span class="scout-v13-risk scout-v13-risk-${s(`scout-v13-risk-${e}`)}">${n(a[e]||e)}</span>`).join(``),g=(e.trunk?.edges||[]).map(e=>y(e,n)).join(``),_=(e.extension?.mainline||[]).map(e=>v(e,n,!1)).join(``),b=(e.extension?.branches||[]).map((e,t)=>`<div class="scout-v13-branch" data-branch="${t}">
        ${(Array.isArray(e)?e:e.edges||[]).map(e=>v(e,n,!0)).join(``)}
      </div>`).join(``),x=(e.trunk?.edges||[]).filter(e=>e.evidenceSource===`personal`).map(e=>n(`他的對局中此路徑出現 ${Number(e.receipts?.games)||0} 次`)),S=``;r&&e.trunkUcis?.length&&(S=`<div class="scout-v13-board">${r(t(e.trunkUcis),e.subjectColor===`white`?`black`:`white`)}</div>`);let C=e.extension?.leafCount??e.auditedLeaves?.length??`—`,w=Number(e.receipts?.sfDepth)||`—`;return`<article class="scout-v13-card" data-package-id="${n(e.id)}">
    <header class="scout-v13-card-head">
      <div class="scout-v13-card-title">
        <span class="scout-v13-entry">${f}</span>
        <span class="scout-v13-style ${c}">${n(d)}</span>
        ${h}
      </div>
      ${S}
    </header>
    <section class="scout-v13-why">
      <h4>${n(`為什麼從這裡進`)}</h4>
      <p>${x.join(` · `)||n(`個人樣本收據`)} · reach LB ${n(p)}</p>
    </section>
    <section class="scout-v13-trunk">
      ${g}
    </section>
    <div class="scout-v13-anchor-divider">─── ${n(`個人樣本止於此(ply ${m})`)} ───</div>
    <section class="scout-v13-extension">
      ${_}
      ${b}
    </section>
    <footer class="scout-v13-receipts">
      <span>${n(`explorer ${e.receipts?.ratingBand||`—`} / ${e.receipts?.speed||`—`}`)}</span>
      <span>${n(`SF d${w} ${e.receipts?.engineLabel||`browser`}`)}</span>
      <span>${n(`leaves ${C}`)}</span>
    </footer>
  </article>`}function x(e){let t={"extension:soundnessFail":`延伸段引擎差距過大`,"extension:tooShort":`延伸段過短`,"extension:endpointEval":`延伸終點評估不佳`,"factuality:trunkPersonal":`主幹缺少足夠個人樣本`,"factuality:cohort":`延伸段缺少分段事實支撐`,"audit:mainlineLeaf":`主線終點未通過審計`,"personalAnchor:emptyTrunk":`無有效個人錨點`};return t[e]?t[e]:e.startsWith(`memorability:`)?`記憶負荷超出預算`:e.startsWith(`schema:`)?`套件結構未通過驗證`:e}function S(e){let t=new Map;for(let n of e||[])for(let e of n.reasons||[])t.set(e,(t.get(e)||0)+1);return[...t.entries()].sort((e,t)=>t[1]-e[1]).slice(0,5).map(([e,t])=>`${x(e)} (${t})`)}function C(e,t={}){let n=t.escapeHtml||(e=>String(e)),r=e?.report||e,a=e?.meta||{},o=r?.packages||[];if(!o.length){let e=S(r?.eliminated),t=a.explorerAvailable===!1?`<p class="scout-v13-note">${n(`同分段資料不可用(未連結 Lichess)`)}</p>`:``;return`<div class="scout-v13-empty">
      <p class="scout-v13-empty-title">${n(`尚無備戰套件`)}</p>
      ${t}
      ${e.length?`<ul class="scout-v13-empty-reasons">${e.map(e=>`<li>${n(e)}</li>`).join(``)}</ul>`:``}
    </div>`}let s=(r?.bucketVacancies||[]).map(e=>{let t=i[e.bucket]||e.bucket;return`<p class="scout-v13-vacancy">${n(`此風格桶(${t})無過門檻候選`)}</p>`}).join(``),c=o.map(e=>b({...e,receipts:{...e.receipts||{},sfDepth:a.sfDepth,ratingBand:a.ratingBand,speed:a.speeds,engineLabel:a.engineLabel}},n,t.renderMiniBoard)).join(``),l=r?.eliminated||[];return`<div class="scout-v13-report">
    ${s}
    <div class="scout-v13-cards">${c}</div>
    ${l.length?`<details class="scout-v13-eliminated">
        <summary>${n(`淘汰 ${l.length} 條候選`)}</summary>
      </details>`:``}
  </div>`}function w(e={}){let t=e.escapeHtml||(e=>String(e)),n=e.playerName?t(e.playerName):t(`對手`),r=e.reportHtml||``,i=e.canGenerate!==!1,a=!!e.running,o=a&&!e.progressTotal,s=e.progressTotal?Math.min(100,Math.round(Number(e.progressDone)/Number(e.progressTotal)*100)):0,c=t(e.progressLabel||`產生備戰套件中…`),l=a?`<div class="scout-v13-progress scout-engine-progress${o?` is-indeterminate`:``}" role="progressbar">
        <div class="scout-progress-row">
          <span class="scout-progress-label">${c}</span>
          <span class="scout-progress-count">${o?``:`${s}%`}</span>
        </div>
        <div class="scout-progress-track">
          <div class="scout-progress-fill" style="width:${o?40:s}%"></div>
        </div>
      </div>`:``,u=a?`<button type="button" class="scout-btn btn ghost" id="scout-v13-cancel-btn">${t(`取消`)}</button>`:``;return`<div class="scout-v13-panel">
    <div class="scout-v13-panel-head">
      <strong>${t(`Prep packages`)}</strong>
      <span class="scout-v13-badge">v13</span>
    </div>
    <p class="scout-v13-subject">${t(`棋手`)}: <strong>${n}</strong></p>
    <div class="scout-v13-actions">
      <button type="button" class="scout-btn btn primary" id="scout-v13-generate-btn"
        ${i&&!a?``:`disabled`}>${t(`Generate prep packages`)}</button>
      ${u}
    </div>
    ${l}
    <div id="scout-v13-report-host">${r}</div>
  </div>`}function T(e){let t=String(e).toLowerCase();if(t.includes(`pitilt`))throw Error(`v13 report must not contain piTilt`);for(let e of n)if(t.includes(e.toLowerCase()))throw Error(`v13 report must not contain banned vocab: ${e}`);for(let t of r)if(e.includes(t))throw Error(`v13 report must not contain personal-subject phrase on non-personal edges: ${t}`)}export{T as assertV13ReportClean,w as renderV13PanelShell,C as renderV13Report};