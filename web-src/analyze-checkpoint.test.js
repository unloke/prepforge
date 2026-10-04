import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { IDBFactory, IDBObjectStore, IDBKeyRange, IDBDatabase } from "fake-indexeddb";
import { clearCheckpoint, evalMapFrom, listCheckpointGames, loadCheckpoint, markCheckpointSaved, saveCheckpoint } from "./analyze-checkpoint.js";
const sample = {requestId:"sample",gameId:"g",ownerId:"a",pgn:"1. e4",positions:["fen"],evals:[["fen",{score_cp:12}]],savedAt:1};
beforeEach(()=>{vi.stubGlobal("indexedDB",new IDBFactory());vi.stubGlobal("IDBKeyRange",IDBKeyRange);});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
it("round trips analysis and keeps accounts isolated",async()=>{
  expect(await saveCheckpoint(sample)).toBe(true);
  expect(await loadCheckpoint("g","a")).toEqual(sample);
  expect(await loadCheckpoint("g","b")).toBeNull();
});
it("finds the newest game using metadata",async()=>{
  await saveCheckpoint(sample);await saveCheckpoint({...sample,gameId:"h",requestId:"second",savedAt:2});
  expect((await loadCheckpoint(null,"a")).gameId).toBe("h");
  expect(await listCheckpointGames("a")).toEqual([{gameId:"h",savedAt:2},{gameId:"g",savedAt:1}]);
});
it("metadata failure rolls back the payload too",async()=>{
  const put=IDBObjectStore.prototype.put;
  vi.spyOn(IDBObjectStore.prototype,"put").mockImplementation(function(...args){
    if(this.name==="metadata") throw new DOMException("Quota exceeded","QuotaExceededError");
    return put.apply(this,args);
  });
  expect(await saveCheckpoint(sample)).toBe(false);
  expect(await loadCheckpoint("g","a")).toBeNull();
  expect(await listCheckpointGames("a")).toEqual([]);
});
it("never evicts unsaved games at the old count or size limits",async()=>{
  for(let i=0;i<51;i++) expect(await saveCheckpoint({...sample,gameId:String(i)})).toBe(true);
  expect(await listCheckpointGames("a")).toHaveLength(51);
  expect(await saveCheckpoint({...sample,pgn:"x".repeat(4_000_001)})).toBe(true);
});
it("a delayed clear cannot delete a newer checkpoint for the same game",async()=>{
  await saveCheckpoint(sample);await saveCheckpoint({...sample,requestId:"second",savedAt:2});
  await clearCheckpoint("g","a","sample");expect((await loadCheckpoint("g","a")).savedAt).toBe(2);
  await clearCheckpoint("g","a","second");expect(await loadCheckpoint("g","a")).toBeNull();
});
it("storage unavailable reports failure and leaves memory recovery to the caller",async()=>{
  vi.stubGlobal("indexedDB",{open(){throw Error("blocked");}});
  expect(await saveCheckpoint(sample)).toBe(false);expect(await loadCheckpoint(null,"a")).toBeNull();
  expect(await clearCheckpoint("g","a")).toBe(false);
});
it("restores evaluation pairs and skips malformed entries",()=>{
  expect([...evalMapFrom({evals:[["f",{}],null,["bad"]]})]).toEqual([["f",{}]]);
});
it("same-millisecond computations still have distinct checkpoint versions", async () => {
  await saveCheckpoint({ ...sample, requestId: "first" });
  await saveCheckpoint({ ...sample, requestId: "second" });
  await clearCheckpoint("g", "a", "first");
  expect((await loadCheckpoint("g", "a")).requestId).toBe("second");
});
it('latest lookup uses one transaction and no metadata getAll even on timestamp ties',async()=>{
  await saveCheckpoint({...sample,gameId:'a'});await saveCheckpoint({...sample,gameId:'z'});
  const getAll=vi.spyOn(IDBObjectStore.prototype,'getAll');
  expect((await loadCheckpoint(null,'a')).gameId).toBe('z');expect(getAll).not.toHaveBeenCalled();
});

it("receipt marking preserves newer computation and persists confirmed cleanup state", async () => {
  await saveCheckpoint(sample);
  await saveCheckpoint({...sample, requestId:"new"});
  await markCheckpointSaved("g", "a", "sample");
  expect((await loadCheckpoint("g", "a")).serverSaved).toBeUndefined();
  await markCheckpointSaved("g", "a", "new");
  expect((await loadCheckpoint("g", "a")).serverSaved).toBe(true);
});
it("latest metadata and payload use the same transaction during concurrent deletion", async () => {
  await saveCheckpoint({...sample, gameId:"older"});
  await saveCheckpoint({...sample, gameId:"newer", savedAt:2, requestId:"newer"});
  const transactions = vi.spyOn(IDBDatabase.prototype,"transaction");
  const loaded = await loadCheckpoint(null,"a");
  expect(loaded.gameId).toBe("newer");
  expect(transactions).toHaveBeenCalledTimes(1);
  const [result] = await Promise.all([loadCheckpoint(null,"a"),clearCheckpoint("newer","a","newer")]);
  expect(["newer","older"]).toContain(result.gameId);
});
