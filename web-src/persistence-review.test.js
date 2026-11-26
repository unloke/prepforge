import { expect, it, vi } from 'vitest';
import { appSource } from "./test-app-source.js";
const source = appSource();
function compile(marker, deps) {
  if (marker === 'async function exportBuild(') deps = {buildOpMatchesRepertoire: compile('function buildOpMatchesRepertoire(', {}), ...deps};
  const start = source.indexOf(marker), end = source.indexOf('\n}\n', start) + 2;
  return new Function(...Object.keys(deps), `return (${source.slice(start, end)});`)(...Object.values(deps));
}
function deferred() { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise,resolve,reject}; }
it('annotations keep the clicked node while a flush is pending', async () => {
  const flush = deferred();
  const nodeA = {arrows: [], circles: []}, nodeB = {arrows: [], circles: []};
  const appState = {build: {repertoire_id:'A', revision:1}, buildCurrentNodeId:'a', buildNodeById:new Map([['a',nodeA],['b',nodeB]])};
  const postJson = vi.fn(async () => ({}));
  const save = compile('async function saveBuildAnnotations(', {appState, activeViewName:()=> 'build', isBuildReadOnly:()=>false,
    currentOwnerId:()=> 'owner', hardFlushBuild:()=>flush.promise, resolveBuildId:id=>id, postJson, setStatusError:vi.fn(), boards:{build:{setAnnotations:vi.fn()}}});
  const pending=save(['Ge2e4'],[]); appState.buildCurrentNodeId='b'; flush.resolve(); await pending;
  expect(postJson).toHaveBeenCalledWith('/api/build/annotations',expect.objectContaining({repertoire_id:'A',node_id:'a'}));
  expect(nodeB.arrows).toEqual([]);
});
it('export keeps the clicked repertoire during sync', async () => {
  const flush=deferred(), appState={build:{repertoire_id:'A'}}, api=vi.fn(async()=>({filename:'A.pgn'}));
  const run=compile('async function exportBuild(', {appState,currentOwnerId:()=> 'owner', hardFlushBuild:()=>flush.promise,
    resolveBuildId:id=>id,api,postJson:vi.fn(),downloadText:vi.fn(),setStatus:vi.fn(),setStatusError:vi.fn()});
  const pending=run(); appState.build={repertoire_id:'B'}; flush.resolve(); await pending;
  expect(api).toHaveBeenCalledWith(expect.stringContaining('repertoire_id=A'));
});
it('Library export downloads the requested repertoire without changing the open tree', async () => {
  const appState={build:{repertoire_id:'open'}}, payload={filename:'Library.pgn',mime:'application/x-chess-pgn',content:'1. e4 e5 (1... c5) *'};
  const api=vi.fn(async()=>payload),downloadText=vi.fn();
  const run=compile('async function exportBuild(', {appState,currentOwnerId:()=> 'owner',hardFlushBuild:async()=>{},api,downloadText,setStatus:vi.fn(),setStatusError:vi.fn()});
  await run('library id');
  expect(api).toHaveBeenCalledWith('/api/repertoires/export-pgn?repertoire_id=library%20id');
  expect(downloadText).toHaveBeenCalledWith(payload.filename,payload.mime,payload.content);
  expect(appState.build.repertoire_id).toBe('open');
});
it('export without a repertoire requests nothing', async () => {
  const api=vi.fn(),setStatus=vi.fn();
  const run=compile('async function exportBuild(', {appState:{},api,setStatus});
  await run();expect(api).not.toHaveBeenCalled();expect(setStatus).toHaveBeenCalledWith('Open a repertoire first');
});
for (const queue of ['buildPending', 'buildPendingDeletes']) {
  it(`Library export refuses stale PGN with queued ${queue} for a non-open repertoire`, async () => {
    const appState={build:{repertoire_id:'open'},buildPending:[],buildPendingDeletes:[]};
    const api=vi.fn(),downloadText=vi.fn(),setStatusError=vi.fn();
    const hardFlushBuild=vi.fn(async()=>{appState[queue].push({repertoire_id:'library',id:'move'});});
    const run=compile('async function exportBuild(', {appState,currentOwnerId:()=> 'owner',hardFlushBuild,api,downloadText,setStatus:vi.fn(),setStatusError});
    await run('library');
    expect(hardFlushBuild).toHaveBeenCalledOnce();
    expect(api).not.toHaveBeenCalled();expect(downloadText).not.toHaveBeenCalled();
    expect(setStatusError).toHaveBeenCalledWith('Open this repertoire to sync your latest moves, then export.');
    appState[queue]=[{repertoire_id:'other',id:'unrelated'}];
    hardFlushBuild.mockImplementation(async()=>{});
    api.mockResolvedValue({filename:'Library.pgn',mime:'application/x-chess-pgn',content:'1. e4 *'});
    await run('library');
    expect(downloadText).toHaveBeenCalledOnce();
  });
}
it('Library export stops on failed sync or an account switch', async () => {
  const api=vi.fn(async()=>({})),downloadText=vi.fn(),setStatusError=vi.fn();let owner='owner';
  const deps={appState:{},currentOwnerId:()=>owner,hardFlushBuild:async()=>{throw Error('offline');},api,downloadText,setStatus:vi.fn(),setStatusError};
  await compile('async function exportBuild(',deps)('library');
  expect(api).not.toHaveBeenCalled();expect(setStatusError).toHaveBeenCalledWith('offline');
  deps.hardFlushBuild=async()=>{owner='other';};
  await compile('async function exportBuild(',deps)('library');
  expect(downloadText).not.toHaveBeenCalled();
});
it('a failed annotation save restores the confirmed node and visible board', async()=>{
  const node={arrows:['Ga1a2'],circles:[]}, board={setAnnotations:vi.fn()};
  const appState={build:{repertoire_id:'r',revision:1},buildCurrentNodeId:'a',buildNodeById:new Map([['a',node]])};
  const run=compile('async function saveBuildAnnotations(',{appState,currentOwnerId:()=> 'owner',activeViewName:()=> 'build',isBuildReadOnly:()=>false,
    hardFlushBuild:async()=>{},resolveBuildId:id=>id,postJson:async()=>{throw Error('offline');},setStatusError:vi.fn(),boards:{build:board}});
  await run(['Ge2e4'],[]); expect(node.arrows).toEqual(['Ga1a2']); expect(board.setAnnotations).toHaveBeenCalledWith(['Ga1a2'],[]);
});
function fileHarness() {
  const input={value:''},appState={}; let seq=0;
  const deps={appState,currentOwnerId:()=> 'owner',invalidateAnalysisSource:()=>++seq,
    document:{getElementById:()=>input,querySelector:()=>null},loadPgnIntoAnalyze:vi.fn(async()=>true),
    orientAnalysisFromPgn:vi.fn(),setStatus:vi.fn(),setStatusError:vi.fn()};
  const run=compile('async function fillPgnInputFromFile(',deps);
  return {run,input,deps};
}
it('late first file cannot replace the second file',async()=>{
  const h=fileHarness(),a=deferred(),b=deferred();
  const first=h.run({name:'A',text:()=>a.promise}),second=h.run({name:'B',text:()=>b.promise});
  b.resolve('B'); await second; a.resolve('A'); await first;
  expect(h.input.value).toBe('B'); expect(h.deps.loadPgnIntoAnalyze).toHaveBeenCalledTimes(1);
});
it('parse failure never reports a file as loaded',async()=>{
  const h=fileHarness();h.deps.loadPgnIntoAnalyze.mockResolvedValue(false);
  await h.run({name:'bad.pgn',text:async()=> 'invalid'});
  expect(h.deps.setStatus.mock.calls.some(([s])=>s.startsWith('Loaded'))).toBe(false);
});
it('discard clears the checkpoint bound to the prompt and its memory copy',async()=>{
  const a={ownerId:'owner',gameId:'A',inMemoryOnly:true},appState={analysisRetryCheckpoint:a,analysisUnsavedCheckpoint:a};
  const clearCheckpoint=vi.fn(), loadCheckpoint=vi.fn(()=>({ownerId:'owner',gameId:'B'}));
  const run=compile('async function discardAnalyzeCheckpoint(',{appState,currentOwnerId:()=> 'owner',clearCheckpoint,loadCheckpoint,refreshAnalyzeRecovery:vi.fn(),hideAnalysisRetrySave:vi.fn(),setStatus:vi.fn()});
  await run();expect(appState.analysisUnsavedCheckpoint).toBeNull();expect(clearCheckpoint).not.toHaveBeenCalled();expect(loadCheckpoint).not.toHaveBeenCalled();
});
it('Retry save has only one request in flight',async()=>{
  const response=deferred(),checkpoint={ownerId:'owner',gameId:'g'},appState={analysisUnsavedCheckpoint:checkpoint};
  const postJson=vi.fn(()=>response.promise),run=compile('async function retryAnalyzeSave(',{
    appState,currentOwnerId:()=> 'owner',loadCheckpoint:()=>null,invalidateAnalysisSource:()=>1,analysisRecallSeq:2,
    document:{getElementById:()=>null},evalMapFrom:()=>new Map(),classifyPositions:compile('function classifyPositions(',{}),postJson,finishAnalyzeCheckpoint:vi.fn(),clearCheckpoint:vi.fn(),hideAnalysisRetrySave:vi.fn(),
    refreshAnalysisHistoryIfOpen:vi.fn(),isAuthError:()=>false,showAnalysisRetrySave:vi.fn()});
  const a=run(),b=run(); expect(postJson).toHaveBeenCalledTimes(1);response.resolve({});await Promise.all([a,b]);
});
it('annotation saves serialize so a failed first drawing cannot poison a later rollback',async()=>{
  const first=deferred(),node={arrows:['Ga1a2'],circles:[]};
  const appState={build:{repertoire_id:'r',revision:1},buildCurrentNodeId:'a',buildNodeById:new Map([['a',node]])};
  const postJson=vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce({});
  const run=compile('async function saveBuildAnnotations(',{appState,currentOwnerId:()=> 'owner',activeViewName:()=> 'build',isBuildReadOnly:()=>false,
    hardFlushBuild:async()=>{},resolveBuildId:id=>id,postJson,setStatusError:vi.fn(),boards:{build:{setAnnotations:vi.fn()}}});
  const a=run(['Ge2e4'],[]);
  await vi.waitFor(()=>expect(postJson).toHaveBeenCalledTimes(1));
  const b=run(['Gd2d4'],[]);
  first.reject(Error('offline'));await Promise.all([a,b]);
  expect(postJson).toHaveBeenCalledTimes(2);expect(node.arrows).toEqual(['Gd2d4']);
});
it('failed prerequisite sync restores the visible confirmed annotation',async()=>{
  const board={setAnnotations:vi.fn()},node={arrows:['Ga1a2'],circles:[]};
  const appState={build:{repertoire_id:'r'},buildCurrentNodeId:'a',buildNodeById:new Map([['a',node]])};
  const run=compile('async function saveBuildAnnotations(',{appState,currentOwnerId:()=> 'owner',activeViewName:()=> 'build',isBuildReadOnly:()=>false,
    hardFlushBuild:async()=>{throw Error('offline');},resolveBuildId:id=>id,postJson:vi.fn(),setStatusError:vi.fn(),boards:{build:board}});
  await run(['Ge2e4'],[]);expect(board.setAnnotations).toHaveBeenCalledWith(['Ga1a2'],[]);
});
