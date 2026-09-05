import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { DurableTemperatureHistory, summarizeTemperatures, type TemperatureSample } from "../src/temperature-history.js";

const values = (cpu: number | null, storage: number | null = null, gpu: number | null = null) => ({ cpu, storage, gpu });

test("derives Tokyo daily and all-time maxima from raw samples", () => {
  const samples: TemperatureSample[] = [
    { deviceId: "tx", timestamp: "2026-09-02T14:59:00.000Z", values: values(70, 40) },
    { deviceId: "tx", timestamp: "2026-09-02T15:01:00.000Z", values: values(50, 45) },
    { deviceId: "tx", timestamp: "2026-09-03T15:01:00.000Z", values: values(60, 42) },
    { deviceId: "tx", timestamp: "2026-09-04T15:01:00.000Z", values: values(55, null) }
  ];
  const result = summarizeTemperatures(samples, "tx", values(55), "2026-09-04T16:00:00.000Z");
  assert.deepEqual([result.cpu.todayMaxC, result.cpu.yesterdayMaxC, result.cpu.twoDaysAgoMaxC], [55, 60, 50]);
  assert.equal(result.cpu.allTimeMaxC, 70);
  assert.equal(result.cpu.allTimeMaxTimestamp, "2026-09-02T14:59:00.000Z");
  assert.equal(result.gpu.todayMaxC, null);
});

test("persists raw observations and restores them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lcc-temperature-"));
  const path = join(directory, "history.jsonl");
  const history = await DurableTemperatureHistory.open(path);
  await history.observe("machine", "2026-09-05T00:00:00.000Z", values(41, 35, 60), "2026-09-05T00:00:00.000Z");
  const reopened = await DurableTemperatureHistory.open(path);
  const summary = await reopened.observe("machine", "2026-09-05T01:00:00.000Z", values(43, 36, 58), "2026-09-05T01:00:00.000Z");
  assert.equal(summary.cpu.allTimeMaxC, 43);
  assert.equal(summary.gpu.allTimeMaxC, 60);
  const stored = (await readFile(path, "utf8")).trim().split("\n");
  assert.equal(stored.length, 2);
});
