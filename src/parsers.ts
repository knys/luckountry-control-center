export type SmartHealth = "PASSED" | "FAILED" | "UNKNOWN";

export function parseOsRelease(text: string): string {
  const values = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (match?.[1] && match[2] !== undefined) {
      values.set(match[1], match[2].replace(/^['\"]|['\"]$/g, ""));
    }
  }
  return values.get("PRETTY_NAME") ?? values.get("NAME") ?? "Unknown Linux";
}

export function parseCpuModel(cpuInfo: string): string {
  return cpuInfo.match(/^model name\s*:\s*(.+)$/m)?.[1]?.trim() ?? "Unknown CPU";
}

export interface CpuTimes { idle: number; total: number }
export function parseCpuTimes(stat: string): CpuTimes | null {
  const line = stat.split("\n").find((item) => item.startsWith("cpu "));
  if (!line) return null;
  const values = line.trim().split(/\s+/).slice(1).map(Number);
  if (values.length < 4 || values.some((value) => !Number.isFinite(value))) return null;
  return { idle: (values[3] ?? 0) + (values[4] ?? 0), total: values.reduce((a, b) => a + b, 0) };
}

export function cpuUsage(previous: CpuTimes | null, current: CpuTimes | null): number | null {
  if (!previous || !current) return null;
  const total = current.total - previous.total;
  const idle = current.idle - previous.idle;
  if (total <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((1 - idle / total) * 1000) / 10));
}

export function parseSmartHealth(text: string): SmartHealth {
  const match = text.match(/(?:overall-health self-assessment test result|SMART Health Status):\s*(\S+)/i);
  if (!match?.[1]) return "UNKNOWN";
  const value = match[1].toUpperCase();
  return value === "PASSED" || value === "OK" ? "PASSED" : "FAILED";
}

export function parseSmartTemperature(text: string): number | null {
  const attribute = text.match(
    /^\s*\d+\s+(?:Temperature_Celsius|Temperature_Internal|Airflow_Temperature_Cel)\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(-?\d+)(?:\s|$)/im
  );
  if (attribute?.[1]) return Number(attribute[1]);
  const modern = text.match(/Temperature(?: Sensor \d+)?\s*:\s*(-?\d+)\s+Celsius/i);
  return modern?.[1] ? Number(modern[1]) : null;
}

export function severity(percent: number | null, warning = 75, error = 90): "online" | "warning" | "error" | "unknown" {
  if (percent === null || !Number.isFinite(percent)) return "unknown";
  if (percent >= error) return "error";
  if (percent >= warning) return "warning";
  return "online";
}
