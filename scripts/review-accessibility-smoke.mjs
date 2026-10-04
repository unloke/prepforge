import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, extname } from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const root=fileURLToPath(new URL('..',import.meta.url));
const staticDir=join(root,'src/prepforge_chess/web/static');
const fen='rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const rep={id:'audit-rep',name:'Audit repertoire',color:'white',root_fen:fen,notes:'',tags:[],is_active:true,visibility:'private',health:{trainable:1,mastered:0,weak:0,due:0,learning:0,untrained:1,mastery_pct:0}};
let repertoireCalls=0;
let libraryMode='populated';
const server=createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname.startsWith('/api/')){
    let data={};
    if(url.pathname==='/api/auth/me')data={id:'audit',display_name:'Audit',email:'audit@example.invalid'};
    if(url.pathname==='/api/auth/providers')data={google:false};
    if(url.pathname==='/api/csrf')data={csrf_token:'audit'};
    if(url.pathname==='/api/repertoires'){
      repertoireCalls++;
      if(libraryMode==='error'){
        res.writeHead(503,{'Content-Type':'application/json'});
        res.end(JSON.stringify({detail:'Library temporarily unavailable'}));return;
      }
      data={repertoires:libraryMode==='empty'?[]:[rep],shared:[]};
    }
    if(url.pathname==='/api/dashboard')data={games:0,repertoires:1,training_sessions:0,open_mistakes:0,due_reviews:0,due_soon:0,streak:{current:0,best:0,trained_today:false},recap:{},recommendations:[]};
    if(url.pathname.startsWith('/api/lichess'))data={linked:false,accounts:[]};
    if(url.pathname==='/api/build/load')data={repertoire_id:rep.id,name:rep.name,color:'white',root_fen:fen,selected_node_id:'root',nodes:[{id:'root',depth:0,parent_id:null,uci:null,fen,children:[]}],health:rep.health};
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(data));return;
  }
  const name=url.pathname==='/'?'/index.html':url.pathname.replace(/^\/static/,'');
  try{const body=await readFile(join(staticDir,name));res.writeHead(200,{'Content-Type':({'.js':'text/javascript','.css':'text/css','.html':'text/html','.json':'application/json','.svg':'image/svg+xml','.wasm':'application/wasm'})[extname(name)]||'application/octet-stream','Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp'});res.end(body);}
  catch{res.writeHead(404);res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
let browser;
for(const channel of ['msedge','chrome',undefined]){try{browser=await chromium.launch({headless:true,...(channel?{channel}:{})});break;}catch{}}
if(!browser)throw Error('No browser');
const results={};
try{
  const page=await browser.newPage({ hasTouch: true });
  await page.route('https://**',r=>r.abort());
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`,{waitUntil:'networkidle'});
  await page.locator('[data-row-menu="audit-rep"]').waitFor();
  assert.equal(await page.locator('#dashboard-repertoires .empty-state').count(), 0);
  assert.equal(await page.locator('#shared-banner-note').count(), 0);
  const opener=page.locator('[data-row-menu="audit-rep"]');
  await opener.focus();await opener.press('Enter');
  results.menu=await page.locator('#repertoire-context-menu').evaluate(el=>({visible:!el.hidden,role:el.getAttribute('role'),items:[...el.querySelectorAll('button')].map(b=>b.getAttribute('role')),focus:document.activeElement?.outerHTML.slice(0,180)}));
  assert.equal(results.menu.role, 'menu');
  assert.ok(results.menu.items.every(role => role === 'menuitem'));
  assert.match(results.menu.focus, /data-action="train"/);
  await page.keyboard.press('ArrowDown');
  results.menu.afterArrow=await page.evaluate(()=>document.activeElement?.getAttribute('data-action'));
  assert.equal(results.menu.afterArrow, 'edit');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.action), 'delete');
  await page.keyboard.press('Escape');
  results.menu.afterEscape=await page.locator('#repertoire-context-menu').evaluate(el=>({hidden:el.hidden,focus:document.activeElement?.getAttribute('data-row-menu')}));
  assert.deepEqual(results.menu.afterEscape, { hidden: true, focus: 'audit-rep' });
  await opener.press('Enter');
  await page.locator('#lib-filter-search').click();
  assert.equal(await page.locator('#repertoire-context-menu').evaluate(el=>el.hidden), true);
  assert.equal(await page.evaluate(()=>document.activeElement.id), 'lib-filter-search');
  await page.setViewportSize({ width: 390, height: 844 });
  await opener.tap();
  assert.equal(await page.locator('#repertoire-context-menu').getAttribute('role'), 'menu');
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.locator('#open-palette').click();
  results.palette={};
  for(const query of ['analyze','games','game','review']){
    await page.locator('#palette-input').fill(query);
    results.palette[query]=await page.locator('#palette-results [data-palette-id]').evaluateAll(els=>els.map(el=>({id:el.dataset.paletteId,label:el.querySelector('.palette-item-label').textContent})));
  }
  await page.locator('#palette-input').fill('game');await page.locator('#palette-input').press('Enter');
  results.palette.gameEnter=await page.evaluate(()=>document.querySelector('.view.is-active')?.id||document.querySelector('.view:not([hidden])')?.id);
  assert.equal(results.palette.game[0].id, 'view:replay:games');
  assert.equal(results.palette.analyze.length, 1);
  assert.equal(results.palette.gameEnter, 'view-replay');
  await page.locator('#open-palette').click();await page.locator('#palette-input').fill('settings');await page.locator('#palette-input').press('Enter');
  await page.locator('#engine-info').waitFor({state:'visible'});await page.locator('#engine-info').click();
  results.info=await page.locator('#engine-info').evaluate(el=>({expanded:el.getAttribute('aria-expanded'),controls:el.getAttribute('aria-controls'),hidden:document.getElementById('engine-info-pop').hidden}));
  await page.keyboard.press('Escape');
  results.info.afterEscape=await page.locator('#engine-info-pop').evaluate(el=>el.hidden);
  await page.locator('#engine-info').click();
  results.info.reopen=await page.locator('#engine-info-pop').evaluate(el=>!el.hidden);
  assert.equal(results.info.controls, 'engine-info-pop');
  assert.equal(results.info.expanded, 'true');
  assert.equal(results.info.afterEscape, true);
  assert.equal(results.info.reopen, true);
  await page.locator('#open-palette').click();await page.locator('#palette-input').fill('scout');await page.locator('#palette-input').press('Enter');
  results.scoutRepertoireCallsOnNavigation=repertoireCalls;
  results.errors=errors;
  results.forcedColors={};
  await page.emulateMedia({forcedColors:'active',reducedMotion:'reduce'});
  results.forcedColors.active=await page.evaluate(()=>({forced:matchMedia('(forced-colors: active)').matches,reduced:matchMedia('(prefers-reduced-motion: reduce)').matches}));
  libraryMode='empty';
  await page.reload({waitUntil:'networkidle'});
  await page.locator('.rail [data-view="dashboard"]').click();
  await page.locator('#dashboard-repertoires .empty-state').waitFor();
  await page.locator('#dashboard-repertoires [data-lib-action="new"]').click();
  await page.locator('[role="dialog"] .modal-title').filter({hasText:'New repertoire'}).waitFor();
  await page.keyboard.press('Escape');
  libraryMode='error';
  await page.reload({waitUntil:'networkidle'});
  await page.locator('#dashboard-repertoires [role="alert"]').waitFor();
  libraryMode='populated';
  await page.locator('#dashboard-repertoires [data-lib-action="retry-list"]').click();
  await page.locator('[data-row-menu="audit-rep"]').waitFor();
  assert.equal(await page.locator('#dashboard-repertoires .empty-state').count(), 0);
  results.errors=errors;
}
finally{await browser.close();await new Promise(r=>server.close(r));}
assert.deepEqual(results.errors, []);
console.log('Review accessibility browser smoke passed');
