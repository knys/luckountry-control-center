import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type TemperatureSensor = "cpu" | "storage" | "gpu";
export interface TemperatureReading { sensor: TemperatureSensor; temperatureC: number; recordedAt: string }
export interface TemperatureSummary { currentC: number | null; todayMaxC: number | null; yesterdayMaxC: number | null; twoDaysAgoMaxC: number | null; allTimeMaxC: number | null; allTimeMaxTimestamp: string | null }
export type TemperatureHistory = Record<TemperatureSensor, TemperatureSummary>;

interface StoredHistory { version: 1; devices: Record<string, TemperatureReading[]> }
const sensors: TemperatureSensor[] = ["cpu", "storage", "gpu"];
const empty = (): TemperatureSummary => ({ currentC: null, todayMaxC: null, yesterdayMaxC: null, twoDaysAgoMaxC: null, allTimeMaxC: null, allTimeMaxTimestamp: null });

export function tokyoDate(timestamp: string): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.valueOf())) throw new Error("invalid temperature timestamp");
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const value = (type: string) => parts.find(part => part.type === type)?.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function relativeTokyoDates(now: string): string[] {
  const noonUtc = new Date(`${tokyoDate(now)}T03:00:00.000Z`);
  return [0, 1, 2].map(days => tokyoDate(new Date(noonUtc.valueOf() - days * 86_400_000).toISOString()));
}

export function summarizeTemperature(readings: TemperatureReading[], current: Partial<Record<TemperatureSensor, number | null>>, now: string): TemperatureHistory {
  const dates = relativeTokyoDates(now);
  return Object.fromEntries(sensors.map(sensor => {
    const values = readings.filter(reading => reading.sensor === sensor && Number.isFinite(reading.temperatureC) && Number.isFinite(Date.parse(reading.recordedAt)));
    const daily = dates.map(date => values.filter(value => tokyoDate(value.recordedAt) === date).reduce<number | null>((max, value) => max === null || value.temperatureC > max ? value.temperatureC : max, null));
    const peak = values.reduce<TemperatureReading | null>((max, value) => max === null || value.temperatureC > max.temperatureC ? value : max, null);
    return [sensor, { currentC: current[sensor] ?? null, todayMaxC: daily[0]!, yesterdayMaxC: daily[1]!, twoDaysAgoMaxC: daily[2]!, allTimeMaxC: peak?.temperatureC ?? null, allTimeMaxTimestamp: peak?.recordedAt ?? null }];
  })) as TemperatureHistory;
}

export class TemperatureHistoryStore {
  private state: StoredHistory = { version: 1, devices: {} };
  private loaded = false;
  private queue = Promise.resolve();
  constructor(private readonly path: string) {}

  async record(deviceId: string, recordedAt: string, values: Partial<Record<TemperatureSensor, number | null>>): Promise<TemperatureHistory> {
    let result: TemperatureHistory = summarizeTemperature([], values, recordedAt);
    this.queue = this.queue.then(async () => {
      await this.load();
      const readings = this.state.devices[deviceId] ??= [];
      for (const sensor of sensors) {
        const temperatureC = values[sensor];
        if (typeof temperatureC === "number" && Number.isFinite(temperatureC) && !readings.some(value => value.sensor === sensor && value.recordedAt === recordedAt)) readings.push({ sensor, temperatureC, recordedAt });
      }
      result = summarizeTemperature(readings, values, recordedAt);
      await this.persist();
    }).catch(() => { /* Telemetry persistence must never take down the dashboard. */ });
    await this.queue;
    return result;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as StoredHistory;
      if (parsed.version === 1 && parsed.devices && typeof parsed.devices === "object") this.state = parsed;
    } catch { /* A missing or damaged history starts empty. */ }
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, JSON.stringify(this.state), { mode: 0o600 });
    await rename(temporary, this.path);
  }
}
