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
  const postJson = compile('async function postJson(', {appState,api,withBuildRevision,advanceBuildRevision,currentOwnerId:()=> "owner"});
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
it.each(['success','failure'])('History ignores old owner %s responses',async(outcome)=>{
  const response=deferred(),appState={ownerGeneration:1};let owner='A';
  const host={innerHTML:'',querySelector:()=>null,querySelectorAll:()=>[]};
  const load=compile('async function loadAnalysisHistory(',{appState,currentOwnerId:()=>owner,document:{getElementById:()=>host},api:()=>response.promise,escapeHtml:String,localDayOf:String},'let analysisHistorySeq=0;');
  const pending=load();owner='B';appState.ownerGeneration++;host.innerHTML='';
  if(outcome==='success') response.resolve({analyses:[{game_id:'A',white:'Private'}]});else response.reject(Error('A error'));
  await pending;expect(host.innerHTML).toBe('');
});
it('History follows cursors, deduplicates games and retains scroll',async()=>{
  let click;const button={addEventListener:(_t,fn)=>{click=fn;}};
  const host={innerHTML:'',scrollTop:77,querySelector:()=>button,querySelectorAll:()=>[]};
  const api=vi.fn().mockResolvedValueOnce({analyses:[{game_id:'one'}],next_cursor:'next'}).mockResolvedValueOnce({analyses:[{game_id:'one'},{game_id:'two'}]});
  const load=compile('async function loadAnalysisHistory(',{appState:{},currentOwnerId:()=> 'A',document:{getElementById:()=>host},api,escapeHtml:String,localDayOf:String},'let analysisHistorySeq=0;');
  await load();expect(host.innerHTML).toContain('Load more');await click();
  expect(api).toHaveBeenLastCalledWith('/api/analyses?cursor=next');
  expect(host.innerHTML.match(/data-game-id="one"/g)).toHaveLength(1);
  expect(host.innerHTML).toContain('data-game-id="two"');expect(host.scrollTop).toBe(77);
});
it('switching Teams removes old action handlers even when the new detail fails',async()=>{
  const elements=new Map();const el=id=>{if(!elements.has(id))elements.set(id,{innerHTML:'',querySelectorAll:()=>[]});return elements.get(id);};
  el('team-detail-delete').onclick=vi.fn();const response=deferred();
  const open=compile('async function openTeamDetail(',{appState:{},currentOwnerId:()=> 'owner',document:{getElementById:el},renderTeamsList:noop,api:()=>response.promise,escapeHtml:String,teamsView:null},'let teamDetailSeq=0;');
  const pending=open('B');expect(el('team-detail-delete').onclick).toBeNull();expect(el('team-detail-delete').hidden).toBe(true);
  response.reject(Error('offline'));await pending;expect(el('team-detail-delete').onclick).toBeNull();
});
import { loadTeamDirectory } from './team-directory.js';
it('team directory caches empty results and rejects old refreshes and owners',async()=>{
  const first=deferred(),second=deferred();
  const appState={accountUserId:'A',ownerGeneration:1,teams:[]};
  const api=vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockResolvedValue({teams:[]});
  const old=loadTeamDirectory(appState,api);const fresh=loadTeamDirectory(appState,api,{refresh:true});
  second.resolve({teams:[]});await fresh;first.resolve({teams:[{id:'stale'}]});expect(await old).toBeNull();
  await loadTeamDirectory(appState,api);expect(api).toHaveBeenCalledTimes(2);expect(appState.teams).toEqual([]);
  appState.accountUserId='B';appState.ownerGeneration++;await loadTeamDirectory(appState,api);expect(api).toHaveBeenCalledTimes(3);
});
it('shared repertoire refresh ignores an older response',async()=>{
  const first=deferred(),second=deferred();const host={innerHTML:'',querySelectorAll:()=>[]};
  const appState={};const load=compile('async function loadSharedRepertoires(',{appState,currentOwnerId:()=> 'owner',document:{getElementById:()=>host},api:vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise),escapeHtml:String,teamById:()=>null},'let sharedRepertoiresSeq=0;');
  const a=load(),b=load();second.resolve({shared:[]});await b;first.resolve({shared:[{id:'stale'}]});await a;expect(host.innerHTML).not.toContain('stale');
});
it('discarding one recovery refreshes the remaining work',async()=>{
  const checkpoint={ownerId:'owner',gameId:'new',requestId:'r'};
  const appState={analysisRetryCheckpoint:checkpoint};const refreshAnalyzeRecovery=vi.fn();
  await compile('async function discardAnalyzeCheckpoint(',{appState,currentOwnerId:()=> 'owner',clearCheckpoint:async()=>true,refreshAnalyzeRecovery,setStatus:noop,setStatusError:noop})();
  expect(refreshAnalyzeRecovery).toHaveBeenCalledOnce();expect(appState.analysisRetryCheckpoint).toBeNull();
});
it('confirmed save with failed cleanup offers cleanup without classify-save',async()=>{
  const checkpoint={ownerId:'owner',gameId:'g',requestId:'r'};const appState={analysisRetryCheckpoint:checkpoint};
  const showAnalysisRetrySave=vi.fn();
  const finish=compile('async function finishAnalyzeCheckpoint(',{appState,currentOwnerId:()=> 'owner',markCheckpointSaved:async()=>true,clearCheckpoint:async()=>false,showAnalysisRetrySave,refreshAnalyzeRecovery:vi.fn()});
  await finish(checkpoint);expect(checkpoint.serverSaved).toBe(true);expect(showAnalysisRetrySave).toHaveBeenCalledWith(checkpoint);
  const postJson=vi.fn();const retry=compile('async function retryAnalyzeSave(',{appState,currentOwnerId:()=> 'owner',document:{getElementById:()=>null},invalidateAnalysisSource:()=>1,finishAnalyzeCheckpoint:finish,postJson});
  await retry();expect(postJson).not.toHaveBeenCalled();
});
it('recovery rechecks server confirmation after reload when local cleanup failed',async()=>{
  const checkpoint={ownerId:'owner',gameId:'g',requestId:'r'};const appState={};const showAnalysisRetrySave=vi.fn();
  const refresh=compile('async function refreshAnalyzeRecovery(',{appState,currentOwnerId:()=> 'owner',loadCheckpoint:async()=>checkpoint,api:async()=>({saved:true}),clearCheckpoint:async()=>false,showAnalysisRetrySave});
  await refresh();expect(showAnalysisRetrySave).toHaveBeenCalledWith(expect.objectContaining({serverSaved:true}));
});
it('workspace restores local work before remote settings or dashboard resolve',async()=>{
  const settings=deferred(),dashboard=deferred();const appState={buildPending:[],buildPendingDeletes:[]};
  const restoreOutbox=vi.fn();const recovery=vi.fn(async()=>{});
  const run=compile('async function loadSignedInWorkspace(',{appState,currentOwnerId:()=> 'owner',loadSettingsActions:async()=>({loadSettingsOnce:()=>settings.promise}),loadDashboard:()=>dashboard.promise,
    getStoredLichessUsername:()=>null,refreshLichessStatus:async()=>{},syncTrainPickerVisibility:noop,syncReplayControls:noop,renderBuilderTree:noop,restoreOutbox,refreshAnalyzeRecovery:recovery});
  const pending=run();expect(restoreOutbox).toHaveBeenCalledOnce();await Promise.resolve();expect(recovery).toHaveBeenCalledOnce();
  settings.resolve();dashboard.resolve();await pending;
});
it('annotations send in-flight plus latest snapshot and never replay earlier drawings',async()=>{
  const first=deferred(),last=deferred(),node={arrows:[],circles:[]},board={setAnnotations:vi.fn()};
  const appState={build:{repertoire_id:'r',revision:1},buildCurrentNodeId:'n',buildNodeById:new Map([['n',node]])};
  const postJson=vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(last.promise);
  const save=compile('async function saveBuildAnnotations(',{appState,currentOwnerId:()=> 'owner',activeViewName:()=> 'build',isBuildReadOnly:()=>false,hardFlushBuild:async()=>{},resolveBuildId:id=>id,postJson,boards:{build:board},setStatusError:noop});
  const a=save(['Ga1a2'],[]);await vi.waitFor(()=>expect(postJson).toHaveBeenCalledTimes(1));
  const b=save(['Ga1a3'],[]),c=save(['Ga1a4'],[]);expect(node.arrows).toEqual(['Ga1a4']);
  first.resolve({revision:2});await vi.waitFor(()=>expect(postJson).toHaveBeenCalledTimes(2));
  expect(postJson.mock.calls[1][1]).toMatchObject({arrows:['Ga1a4'],base_revision:2});
  expect(board.setAnnotations).not.toHaveBeenCalledWith(['Ga1a2'],[]);
  last.reject(Error('offline'));await Promise.all([a,b,c]);
  expect(node.arrows).toEqual(['Ga1a2']);expect(board.setAnnotations).toHaveBeenLastCalledWith(['Ga1a2'],[]);
});
it('Build writes serialize and rebase only their own acknowledged revision',async()=>{
  const first=deferred(),appState={build:{repertoire_id:'r',revision:4},buildPending:[],buildPendingDeletes:[]};
  const api=vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce({revision:6});
  const post=compile('async function postJson(',{appState,currentOwnerId:()=> 'owner',api,withBuildRevision,advanceBuildRevision});
  const a=post('/api/build/annotations',{repertoire_id:'r',base_revision:4}),b=post('/api/build/add-moves',{repertoire_id:'r',base_revision:4});
  expect(api).toHaveBeenCalledTimes(1);first.resolve({revision:5});await Promise.all([a,b]);
  expect(JSON.parse(api.mock.calls[1][1].body).base_revision).toBe(5);
  await post('/api/build/annotations',{repertoire_id:'r',base_revision:3});
  expect(JSON.parse(api.mock.calls[2][1].body).base_revision).toBe(3);
});
it('download responses become Blob directly without text parsing',async()=>{
  const blob=new Blob(['{"large":true}']),text=vi.fn();
  const api=compile('async function api(',{withRequestDeadline:async fn=>fn(new AbortController().signal),headersWithCsrf:async()=>({}),getCsrfToken:noop,fetch:async()=>({ok:true,blob:async()=>blob,text})});
  expect(await api('/api/account/export',{responseType:'blob',timeoutMs:300000})).toBe(blob);expect(text).not.toHaveBeenCalled();
});
it('a Settings read still runs after a write during lazy view loading',async()=>{
  const view=deferred(),appState={signedIn:true};
  const renderSettings=vi.fn();const api=vi.fn(async(_url,options)=>options?.method==='POST'?{maia_rating:2000}:{maia_rating:2000});
  const actions=createSettingsActions({appState,currentOwnerId:()=> 'owner',api,ensureSettingsView:()=>view.promise,applySettingsPayload:p=>{appState.settings=p;},applyServerEngineGating:noop,setStatusError:noop,explorerDrawerOpen:()=>false});
  const load=actions.loadSettingsOnce();await actions.saveSettings({maia_rating:2000});
  view.resolve({renderSettings});await load;
  expect(api).toHaveBeenCalledTimes(2);expect(renderSettings).toHaveBeenCalledWith({maia_rating:2000});
});
