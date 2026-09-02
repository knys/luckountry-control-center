import test from "node:test";
import assert from "node:assert/strict";
import { RemoteDeviceProvider, stateFor, type DeviceThresholds } from "../src/devices.js";

const thresholds: DeviceThresholds = { cpuPercent: 85, temperatureC: 80, memoryPercent: 85, diskPercent: 90, staleMs: 20_000, offlineMs: 60_000 };
const sample = (timestamp: string) => ({ timestamp, hostname: "agent", os: "Test OS", cpuUsagePercent: 20, cpuTemperatureC: 40, memory: { usedBytes: 1, totalBytes: 10, usedPercent: 10 }, filesystem: { usedBytes: 2, totalBytes: 10, usedPercent: 20 }, ipv4: "192.168.1.2", uptimeSeconds: 10 });

test("marks fresh healthy telemetry online", () => assert.equal(stateFor(sample("2026-01-01T00:00:00.000Z"), Date.parse("2026-01-01T00:00:10.000Z"), thresholds), "ONLINE"));
test("marks stale telemetry warning", () => assert.equal(stateFor(sample("2026-01-01T00:00:00.000Z"), Date.parse("2026-01-01T00:00:30.000Z"), thresholds), "WARNING"));
test("marks expired telemetry offline", () => assert.equal(stateFor(sample("2026-01-01T00:00:00.000Z"), Date.parse("2026-01-01T00:01:01.000Z"), thresholds), "OFFLINE"));
test("marks threshold breach warning", () => assert.equal(stateFor({ ...sample("2026-01-01T00:00:00.000Z"), cpuUsagePercent: 90 }, Date.parse("2026-01-01T00:00:01.000Z"), thresholds), "WARNING"));
test("unconfigured remote device is offline without fixed host data", async () => {
  const result = await new RemoteDeviceProvider("test", "TEST DEVICE", undefined).getStatus();
  assert.equal(result.status, "OFFLINE");
  assert.equal(result.hostname, null);
  assert.equal(result.ipv4, null);
});
