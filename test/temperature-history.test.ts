import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TemperatureHistoryStore, summarizeTemperature, tokyoDate, type TemperatureReading } from "../src/temperature-history.js";

test("uses Asia/Tokyo calendar boundaries for daily maxima",()=>{
  assert.equal(tokyoDate("2026-09-04T14:59:59.000Z"),"2026-09-04");
  assert.equal(tokyoDate("2026-09-04T15:00:00.000Z"),"2026-09-05");
  const readings:TemperatureReading[]=[
    {sensor:"cpu",temperatureC:51,recordedAt:"2026-09-05T14:59:59.000Z"},
    {sensor:"cpu",temperatureC:62,recordedAt:"2026-09-04T15:00:00.000Z"},
    {sensor:"cpu",temperatureC:58,recordedAt:"2026-09-03T15:00:00.000Z"},
    {sensor:"cpu",temperatureC:70,recordedAt:"2026-01-01T00:00:00.000Z"}
  ];
  const result=summarizeTemperature(readings,{cpu:48},"2026-09-05T14:59:59.000Z").cpu;
  assert.deepEqual(result,{currentC:48,todayMaxC:62,yesterdayMaxC:58,twoDaysAgoMaxC:null,allTimeMaxC:70,allTimeMaxTimestamp:"2026-01-01T00:00:00.000Z"});
});

test("persists raw available readings and represents unavailable sensors as null",async context=>{
  const directory=await mkdtemp(join(tmpdir(),"lcc-temperature-"));context.after(()=>rm(directory,{recursive:true,force:true}));
  const path=join(directory,"history.json"),first=new TemperatureHistoryStore(path);
  await first.record("tx66kwh","2026-09-05T00:00:00.000Z",{cpu:44,storage:39,gpu:null});
  const result=await new TemperatureHistoryStore(path).record("tx66kwh","2026-09-05T01:00:00.000Z",{cpu:49,storage:null,gpu:null});
  assert.equal(result.cpu.todayMaxC,49);assert.equal(result.storage.allTimeMaxC,39);assert.equal(result.gpu.currentC,null);
  const saved=JSON.parse(await readFile(path,"utf8")) as {devices:{tx66kwh:TemperatureReading[]}};
  assert.equal(saved.devices.tx66kwh.length,3);
});
