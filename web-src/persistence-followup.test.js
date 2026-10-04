import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { createSettingsActions } from './settings-actions.js';
import { withBuildRevision, advanceBuildRevision } from './build-revision.js';
const source = readFileSync(new URL('./app.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function compile(marker, deps, prelude = '') {
  const start = source.indexOf(marker), end = source.indexOf('\n}\n', start) + 2;
  return new Function(...Object.keys(deps), `${prelude}; return (${source.slice(start, end)});`)(...Object.values(deps));
}
function deferred() { let resolve, reject; const promise = new Promise((a,b) => {resolve=a; reject=b;}); return {promise,resolve,reject}; }
const noop = () => {};
it('production annotation wrapper adopts revisions and rebases newly queued moves', async () => {
  const node = {arrows: [], circles: []};
  const appState = {build: {repertoire_id: 'r',revision:4},buildCurrentNodeId:'n',buildNodeById:new Map([['n',node]]),buildPending:[],buildPendingDeletes:[]};
  let revision = 4;
  const api = vi.fn(async (_path, options) => {
    const body = JSON.parse(options.body);
    expect(body.base_revision).toBe(revision);
    appState.buildPending.push({repertoire_id:'r',base_revision:revision});
    return {revision:++revision};
  });
  const postJson = compile('async function postJson(', {appState,api,withBuildRevision,advanceBuildRevision});
  const save = compile('async function saveBuildAnnotations(', {appState,postJson,currentOwnerId:()=> 'owner',activeViewName:()=> 'build',isBuildReadOnly:()=>false,
    hardFlushBuild:async()=>{},resolveBuildId:id=>id,boards:{build:{setAnnotations:noop}},setStatusError:vi.fn()});
  await save(['Ga1a2'],[]); await save(['Ga1a3'],[]);
  expect(appState.build.revision).toBe(6);
  expect(appState.buildPending.every(op=>op.base_revision===6)).toBe(true);
});
it.each([false,true])('Settings reads wait for pending write (failure=%s)', async (failure) => {
  const post = deferred(); const appState = {signedIn:true,settings:{stockfish_depth:12}};
  const depthChanged = vi.fn(async()=>{});
  const api = vi.fn((_url, options)=> options?.method==='POST' ? post.promise : Promise.resolve({stockfish_depth:failure?12:20}));
  const renderSettings = vi.fn();
  const actions = createSettingsActions({appState,currentOwnerId:()=> 'owner',api,ensureSettingsView:async()=>({renderSettings}),
    applySettingsPayload:p=>{appState.settings=p;},applyServerEngineGating:noop,setStatusError:noop,
    positionCoach:{cancel:noop},engineWidget:{onDepthSettingChanged:depthChanged},activeViewName:()=> 'settings',
    explorerEvalEngine:{sync:async()=>{}},explorerDrawerOpen:()=>false});
  const saving = actions.saveSettings({stockfish_depth:20});
  await vi.waitFor(()=>expect(api).toHaveBeenCalledTimes(1));
  const loading = actions.loadSettingsOnce(); await Promise.resolve(); await Promise.resolve();
  expect(api).toHaveBeenCalledTimes(1);
  if(failure) post.reject(Error('offline')); else post.resolve({stockfish_depth:20});
  await Promise.all([saving,loading]);
  expect(appState.settings.stockfish_depth).toBe(failure?12:20);
  expect(depthChanged).toHaveBeenCalledTimes(failure?0:1);
  expect(renderSettings).toHaveBeenCalledWith({stockfish_depth:failure?12:20});
});
