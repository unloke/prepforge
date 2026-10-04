import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { clearCheckpoint, evalMapFrom, listCheckpointGames, loadCheckpoint, saveCheckpoint } from "./analyze-checkpoint.js";
const sample = {gameId:"g",ownerId:"a",pgn:"1. e4",positions:["fen"],evals:[["fen",{score_cp:12}]],savedAt:1};
beforeEach(()=>vi.stubGlobal("indexedDB",new IDBFactory()));
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
it("round trips analysis and keeps accounts isolated",async()=>{
  expect(await saveCheckpoint(sample)).toBe(true);
  expect(await loadCheckpoint("g","a")).toEqual(sample);
  expect(await loadCheckpoint("g","b")).toBeNull();
});
it("finds the newest game using metadata",async()=>{
  await saveCheckpoint(sample);await saveCheckpoint({...sample,gameId:"h",savedAt:2});
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
  await saveCheckpoint(sample);await saveCheckpoint({...sample,savedAt:2});
  await clearCheckpoint("g","a",1);expect((await loadCheckpoint("g","a")).savedAt).toBe(2);
  await clearCheckpoint("g","a",2);expect(await loadCheckpoint("g","a")).toBeNull();
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
