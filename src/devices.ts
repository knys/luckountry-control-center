import { collectSystemStatus } from "./system.js";
import { RemoteWorkerRegistry } from "./infrastructure/remote-execution.js";

export type DeviceState = "ONLINE" | "WARNING" | "OFFLINE";

export interface CapacityStatus {
  usedBytes: number | null;
  totalBytes: number | null;
  usedPercent: number | null;
}

export interface DeviceStatus {
  id: string;
  name: string;
  hostname: string | null;
  status: DeviceState;
  os: string | null;
  cpuUsagePercent: number | null;
  cpuTemperatureC: number | null;
  memory: CapacityStatus;
  filesystem: CapacityStatus;
  ipv4: string | null;
  uptimeSeconds: number | null;
  lastSeen: string | null;
}

export interface DeviceProvider {
  readonly id: string;
  getStatus(): Promise<DeviceStatus>;
}

interface AgentTelemetry {
  timestamp: string;
  hostname: string;
  os: string;
  cpuUsagePercent: number | null;
  cpuTemperatureC: number | null;
  memory: CapacityStatus;
  filesystem: CapacityStatus;
  ipv4: string | null;
  uptimeSeconds: number;
}

export interface DeviceThresholds {
  cpuPercent: number;
  temperatureC: number;
  memoryPercent: number;
  diskPercent: number;
  staleMs: number;
  offlineMs: number;
}

const emptyCapacity = (): CapacityStatus => ({ usedBytes: null, totalBytes: null, usedPercent: null });
const defaults: DeviceThresholds = { cpuPercent: 85, temperatureC: 80, memoryPercent: 85, diskPercent: 90, staleMs: 20_000, offlineMs: 60_000 };

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function capacity(value: unknown): CapacityStatus {
  if (!value || typeof value !== "object") return emptyCapacity();
  const item = value as Record<string, unknown>;
  return { usedBytes: finite(item.usedBytes), totalBytes: finite(item.totalBytes), usedPercent: finite(item.usedPercent) };
}

function warning(telemetry: AgentTelemetry, thresholds: DeviceThresholds): boolean {
  const measurements: Array<readonly [number | null, number]> = [
    [telemetry.cpuUsagePercent, thresholds.cpuPercent],
    [telemetry.cpuTemperatureC, thresholds.temperatureC],
    [telemetry.memory.usedPercent, thresholds.memoryPercent],
    [telemetry.filesystem.usedPercent, thresholds.diskPercent]
  ];
  return measurements.some(([value, limit]) => value !== null && value >= limit);
}

export function stateFor(telemetry: AgentTelemetry, now: number, thresholds: DeviceThresholds = defaults): DeviceState {
  const age = now - Date.parse(telemetry.timestamp);
  if (!Number.isFinite(age) || age > thresholds.offlineMs) return "OFFLINE";
  if (age > thresholds.staleMs || warning(telemetry, thresholds)) return "WARNING";
  return "ONLINE";
}

function parseTelemetry(value: unknown): AgentTelemetry | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (typeof item.timestamp !== "string" || typeof item.hostname !== "string" || typeof item.os !== "string" || typeof item.uptimeSeconds !== "number") return null;
  return {
    timestamp: item.timestamp,
    hostname: item.hostname,
    os: item.os,
    cpuUsagePercent: finite(item.cpuUsagePercent),
    cpuTemperatureC: finite(item.cpuTemperatureC),
    memory: capacity(item.memory),
    filesystem: capacity(item.filesystem),
    ipv4: typeof item.ipv4 === "string" ? item.ipv4 : null,
    uptimeSeconds: item.uptimeSeconds
  };
}

function status(id: string, name: string, telemetry: AgentTelemetry, now: number, thresholds: DeviceThresholds): DeviceStatus {
  return { id, name, hostname: telemetry.hostname, status: stateFor(telemetry, now, thresholds), os: telemetry.os, cpuUsagePercent: telemetry.cpuUsagePercent, cpuTemperatureC: telemetry.cpuTemperatureC, memory: telemetry.memory, filesystem: telemetry.filesystem, ipv4: telemetry.ipv4, uptimeSeconds: telemetry.uptimeSeconds, lastSeen: telemetry.timestamp };
}

export class RemoteDeviceProvider implements DeviceProvider {
  private lastTelemetry: AgentTelemetry | null = null;
  private lastRequestFailed = false;

  constructor(readonly id: string, private readonly name: string, private readonly endpoint: string | undefined, private readonly thresholds: DeviceThresholds = defaults) {}

  async getStatus(): Promise<DeviceStatus> {
    if (this.endpoint) {
      try {
        const response = await fetch(new URL("/telemetry", this.endpoint), { signal: AbortSignal.timeout(2_000) });
        if (!response.ok) throw new Error(`agent returned ${response.status}`);
        const telemetry = parseTelemetry(await response.json());
        if (!telemetry) throw new Error("invalid agent payload");
        this.lastTelemetry = telemetry;
        this.lastRequestFailed = false;
      } catch { this.lastRequestFailed = true; }
    }
    if (this.lastTelemetry) {
      const result = status(this.id, this.name, this.lastTelemetry, Date.now(), this.thresholds);
      if (this.lastRequestFailed && result.status === "ONLINE") result.status = "WARNING";
      return result;
    }
    return { id: this.id, name: this.name, hostname: null, status: "OFFLINE", os: null, cpuUsagePercent: null, cpuTemperatureC: null, memory: emptyCapacity(), filesystem: emptyCapacity(), ipv4: null, uptimeSeconds: null, lastSeen: null };
  }
}

export class LocalDeviceProvider implements DeviceProvider {
  readonly id = "tx66kwh";
  constructor(private readonly name = "TX66KWH", private readonly thresholds: DeviceThresholds = defaults) {}

  async getStatus(): Promise<DeviceStatus> {
    const system = await collectSystemStatus();
    const temperatures = system.cpu.cores.map((core) => core.temperatureC).filter((value): value is number => value !== null);
    const telemetry: AgentTelemetry = {
      timestamp: system.timestamp, hostname: system.host.hostname, os: system.host.os,
      cpuUsagePercent: system.cpu.usagePercent, cpuTemperatureC: temperatures.length ? Math.max(...temperatures) : null,
      memory: { usedBytes: system.memory.usedBytes, totalBytes: system.memory.totalBytes, usedPercent: system.memory.usedPercent },
      filesystem: { usedBytes: system.filesystem.usedBytes, totalBytes: system.filesystem.totalBytes, usedPercent: system.filesystem.usedPercent },
      ipv4: system.network.ipv4, uptimeSeconds: system.host.uptimeSeconds
    };
    return status(this.id, this.name, telemetry, Date.now(), this.thresholds);
  }
}

export class WorkerDeviceProvider implements DeviceProvider {
  readonly id="gtx1060";
  constructor(private readonly registry:RemoteWorkerRegistry,private readonly workerId:string,private readonly baseUrl:string){}
  async getStatus():Promise<DeviceStatus>{const descriptor=await this.registry.get(this.workerId),online=descriptor?.status==="ONLINE";return{id:this.id,name:"GTX1060 PC",hostname:online?"GTX1060":null,status:online?"ONLINE":"OFFLINE",os:online?`LCC Worker ${descriptor.agentVersion??"unknown"} / ${descriptor.codexVersion??"Codex unavailable"}`:null,cpuUsagePercent:null,cpuTemperatureC:null,memory:emptyCapacity(),filesystem:emptyCapacity(),ipv4:online?new URL(this.baseUrl).hostname:null,uptimeSeconds:null,lastSeen:online?new Date().toISOString():null};}
}

export function createDeviceProviders(environment: NodeJS.ProcessEnv = process.env): DeviceProvider[] {
  const workerId=environment.WORKER_ID?.trim(),workerUrl=environment.WORKER_URL?.trim(),keyId=environment.WORKER_HMAC_KEY_ID?.trim(),secret=environment.WORKER_HMAC_SECRET;
  const gtx=workerId&&workerUrl&&keyId&&secret?new WorkerDeviceProvider(new RemoteWorkerRegistry([{workerId,baseUrl:workerUrl,credentials:{keyId,secret}}]),workerId,workerUrl):new RemoteDeviceProvider("gtx1060", "GTX1060 PC", environment.DEVICE_GTX1060_URL);
  return [
    gtx,
    new RemoteDeviceProvider("tobie-box", "TOBIE BOX", environment.DEVICE_TOBIE_URL),
    new LocalDeviceProvider()
  ];
}

export async function collectDeviceStatuses(providers: DeviceProvider[]): Promise<DeviceStatus[]> {
  return Promise.all(providers.map((provider) => provider.getStatus()));
}
