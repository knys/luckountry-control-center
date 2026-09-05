import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

export type TemperatureSensor = "cpu" | "storage" | "gpu";
export type TemperatureValues = Record<TemperatureSensor, number | null>;

export interface TemperatureSample {
  deviceId: string;
  timestamp: string;
  values: TemperatureValues;
}

export interface TemperatureSummary {
  currentC: number | null;
  todayMaxC: number | null;
  yesterdayMaxC: number | null;
  twoDaysAgoMaxC: number | null;
  allTimeMaxC: number | null;
  allTimeMaxTimestamp: string | null;
}

export type DeviceTemperatureHistory = Record<TemperatureSensor, TemperatureSummary>;

const sensors: TemperatureSensor[] = ["cpu", "storage", "gpu"];
const tokyoDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" });

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function dateKey(timestamp: string): string | null {
  const date = new Date(timestamp);
  return Number.isFinite(date.valueOf()) ? tokyoDate.format(date) : null;
}

function previousDateKeys(now: string): [string, string, string] {
  const instant = new Date(now);
  if (!Number.isFinite(instant.valueOf())) throw new Error("invalid observation timestamp");
  return [0, 1, 2].map(days => tokyoDate.format(new Date(instant.valueOf() - days * 86_400_000))) as [string, string, string];
}

function emptySummary(currentC: number | null): TemperatureSummary {
  return { currentC, todayMaxC: null, yesterdayMaxC: null, twoDaysAgoMaxC: null, allTimeMaxC: null, allTimeMaxTimestamp: null };
}

export function summarizeTemperatures(samples: readonly TemperatureSample[], deviceId: string, current: TemperatureValues, now: string): DeviceTemperatureHistory {
  const keys = previousDateKeys(now);
  const result = Object.fromEntries(sensors.map(sensor => [sensor, emptySummary(current[sensor])])) as DeviceTemperatureHistory;
  for (const sample of samples) {
    if (sample.deviceId !== deviceId) continue;
    const day = dateKey(sample.timestamp);
    if (!day) continue;
    for (const sensor of sensors) {
      const value = finite(sample.values[sensor]);
      if (value === null) continue;
      const summary = result[sensor];
      if (day === keys[0] && (summary.todayMaxC === null || value > summary.todayMaxC)) summary.todayMaxC = value;
      if (day === keys[1] && (summary.yesterdayMaxC === null || value > summary.yesterdayMaxC)) summary.yesterdayMaxC = value;
      if (day === keys[2] && (summary.twoDaysAgoMaxC === null || value > summary.twoDaysAgoMaxC)) summary.twoDaysAgoMaxC = value;
      if (summary.allTimeMaxC === null || value > summary.allTimeMaxC) {
        summary.allTimeMaxC = value;
        summary.allTimeMaxTimestamp = sample.timestamp;
      }
    }
  }
  return result;
}

export interface TemperatureHistory {
  observe(deviceId: string, timestamp: string, values: TemperatureValues, now?: string): Promise<DeviceTemperatureHistory>;
}

export class DurableTemperatureHistory implements TemperatureHistory {
  private operation = Promise.resolve();
  private constructor(private readonly path: string, private readonly samples: TemperatureSample[]) {}

  static async open(path: string): Promise<DurableTemperatureHistory> {
    try {
      const samples = (await readFile(path, "utf8")).split("\n").filter(Boolean).flatMap(line => {
        try { return [JSON.parse(line) as TemperatureSample]; } catch { return []; }
      });
      return new DurableTemperatureHistory(path, samples);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return new DurableTemperatureHistory(path, []);
    }
  }

  observe(deviceId: string, timestamp: string, values: TemperatureValues, now = new Date().toISOString()): Promise<DeviceTemperatureHistory> {
    const run = this.operation.then(async () => {
      const sanitized = Object.fromEntries(sensors.map(sensor => [sensor, finite(values[sensor])])) as TemperatureValues;
      if (!this.samples.some(sample => sample.deviceId === deviceId && sample.timestamp === timestamp)) {
        const sample = { deviceId, timestamp, values: sanitized };
        this.samples.push(sample);
        await mkdir(dirname(this.path), { recursive: true });
        await appendFile(this.path, `${JSON.stringify(sample)}\n`, { mode: 0o640 });
      }
      return summarizeTemperatures(this.samples, deviceId, sanitized, now);
    });
    this.operation = run.then(() => undefined, () => undefined);
    return run;
  }
}

export function emptyTemperatureHistory(values: TemperatureValues): DeviceTemperatureHistory {
  return Object.fromEntries(sensors.map(sensor => [sensor, emptySummary(values[sensor])])) as DeviceTemperatureHistory;
}
