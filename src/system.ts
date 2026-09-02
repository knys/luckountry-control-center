import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { hostname, networkInterfaces, release, totalmem, freemem, uptime } from "node:os";
import { statfs } from "node:fs/promises";
import { promisify } from "node:util";
import { cpuUsage, parseCpuModel, parseCpuTimes, parseOsRelease, parseSmartHealth, parseSmartTemperature, severity, type CpuTimes } from "./parsers.js";

const execFileAsync = promisify(execFile);
let previousCpu: CpuTimes | null = null;

async function safeRead(path: string): Promise<string> {
  try { return await readFile(path, "utf8"); } catch { return ""; }
}

async function temperatures(): Promise<Array<number | null>> {
  try {
    const roots = await readdir("/sys/class/hwmon", { withFileTypes: true });
    const cores = new Map<number, number>();
    for (const root of roots) {
      if (!root.isDirectory() && !root.isSymbolicLink()) continue;
      const base = `/sys/class/hwmon/${root.name}`;
      const files = await readdir(base);
      for (const file of files.filter((name) => /^temp\d+_label$/.test(name))) {
        const label = (await safeRead(`${base}/${file}`)).trim();
        const match = label.match(/^Core (\d+)$/i);
        if (!match?.[1]) continue;
        const raw = Number((await safeRead(`${base}/${file.replace("_label", "_input")}`)).trim());
        if (Number.isFinite(raw)) cores.set(Number(match[1]), Math.round(raw / 100) / 10);
      }
    }
    return [cores.get(0) ?? null, cores.get(1) ?? null];
  } catch { return [null, null]; }
}

async function primaryNetwork(): Promise<{ interface: string | null; ipv4: string | null }> {
  const route = await safeRead("/proc/net/route");
  const row = route.split("\n").slice(1).find((line) => line.trim().split(/\s+/)[1] === "00000000");
  const name = row?.trim().split(/\s+/)[0] ?? null;
  const address = name ? networkInterfaces()[name]?.find((item) => item.family === "IPv4" && !item.internal)?.address ?? null : null;
  return { interface: name, ipv4: address };
}

async function serviceActive(name: "ssh"): Promise<boolean | null> {
  try {
    const { stdout } = await execFileAsync("/usr/bin/systemctl", ["is-active", name], { timeout: 2000 });
    return stdout.trim() === "active";
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout?.trim();
    return stdout === "inactive" || stdout === "failed" ? false : null;
  }
}

async function smart(): Promise<{ health: string; temperatureC: number | null; available: boolean }> {
  try {
    const { stdout } = await execFileAsync("/usr/bin/sudo", ["-n", "/usr/local/libexec/luckountry-smart-status"], { timeout: 4000, maxBuffer: 256_000 });
    return { health: parseSmartHealth(stdout), temperatureC: parseSmartTemperature(stdout), available: true };
  } catch { return { health: "UNKNOWN", temperatureC: null, available: false }; }
}

export async function collectSystemStatus() {
  const [osText, cpuInfo, statText, temps, filesystem, network, ssh, diskSmart] = await Promise.all([
    safeRead("/etc/os-release"), safeRead("/proc/cpuinfo"), safeRead("/proc/stat"), temperatures(), statfs("/"), primaryNetwork(), serviceActive("ssh"), smart()
  ]);
  const currentCpu = parseCpuTimes(statText);
  const usage = cpuUsage(previousCpu, currentCpu);
  previousCpu = currentCpu;
  const ramTotal = totalmem();
  const ramUsed = ramTotal - freemem();
  const fsTotal = filesystem.blocks * filesystem.bsize;
  const fsAvailable = filesystem.bavail * filesystem.bsize;
  const fsUsed = fsTotal - fsAvailable;
  return {
    timestamp: new Date().toISOString(),
    host: { hostname: hostname(), os: parseOsRelease(osText), kernel: release(), uptimeSeconds: Math.floor(uptime()) },
    cpu: { model: parseCpuModel(cpuInfo), usagePercent: usage, usageStatus: severity(usage, 70, 90), cores: temps.map((temperatureC, index) => ({ index, temperatureC, status: severity(temperatureC, 75, 90) })) },
    memory: { totalBytes: ramTotal, usedBytes: ramUsed, usedPercent: Math.round(ramUsed / ramTotal * 1000) / 10, status: severity(ramUsed / ramTotal * 100, 75, 90) },
    filesystem: { mount: "/", totalBytes: fsTotal, usedBytes: fsUsed, usedPercent: Math.round(fsUsed / fsTotal * 1000) / 10, status: severity(fsUsed / fsTotal * 100, 80, 92) },
    smart: diskSmart,
    network,
    services: { ssh, controlCenter: true }
  };
}
