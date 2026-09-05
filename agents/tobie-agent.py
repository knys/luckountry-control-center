#!/usr/bin/env python3
"""Tiny read-only Linux telemetry HTTP agent. Python standard library only."""
import json
import os
import platform
import shutil
import socket
import subprocess
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LISTEN_HOST = os.environ.get("DEVICE_AGENT_HOST", "127.0.0.1")
LISTEN_PORT = int(os.environ.get("DEVICE_AGENT_PORT", "9100"))


def read(path):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return handle.read()
    except OSError:
        return ""


def cpu_times():
    fields = read("/proc/stat").splitlines()[0].split()[1:]
    values = [int(value) for value in fields]
    return sum(values), values[3] + (values[4] if len(values) > 4 else 0)


def cpu_usage():
    first = cpu_times()
    time.sleep(0.1)
    second = cpu_times()
    total, idle = second[0] - first[0], second[1] - first[1]
    return round((1 - idle / total) * 100, 1) if total else None


def cpu_temperature():
    values = []
    for root, _, files in os.walk("/sys/class/thermal"):
        for name in files:
            if name == "temp":
                try:
                    value = float(read(os.path.join(root, name)).strip())
                    values.append(value / 1000 if value > 1000 else value)
                except ValueError:
                    pass
    return round(max(values), 1) if values else None


def storage_temperature():
    values = []
    for root, _, files in os.walk("/sys/class/hwmon"):
        name = read(os.path.join(root, "name")).strip().lower()
        if not any(kind in name for kind in ("nvme", "drivetemp")):
            continue
        for filename in files:
            if filename.startswith("temp") and filename.endswith("_input"):
                try:
                    value = float(read(os.path.join(root, filename)).strip())
                    values.append(value / 1000 if value > 1000 else value)
                except ValueError:
                    pass
    return round(max(values), 1) if values else None


def gpu_temperature():
    try:
        output = subprocess.run(
            ["nvidia-smi", "--query-gpu=temperature.gpu", "--format=csv,noheader,nounits"],
            check=True, capture_output=True, text=True, timeout=2
        ).stdout
        values = [float(value) for value in output.split()]
        return round(max(values), 1) if values else None
    except (OSError, subprocess.SubprocessError, ValueError):
        return None


def memory():
    rows = {row.split(":", 1)[0]: int(row.split()[1]) * 1024 for row in read("/proc/meminfo").splitlines() if ":" in row}
    total, available = rows.get("MemTotal", 0), rows.get("MemAvailable", 0)
    used = total - available
    return {"usedBytes": used, "totalBytes": total, "usedPercent": round(used / total * 100, 1) if total else None}


def ipv4():
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(("192.0.2.1", 9))
        return probe.getsockname()[0]
    except OSError:
        return None
    finally:
        probe.close()


def telemetry():
    disk = shutil.disk_usage("/")
    os_name = next((line.split("=", 1)[1].strip().strip('"') for line in read("/etc/os-release").splitlines() if line.startswith("PRETTY_NAME=")), platform.platform())
    return {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "hostname": socket.gethostname(), "os": os_name,
        "cpuUsagePercent": cpu_usage(), "cpuTemperatureC": cpu_temperature(),
        "storageTemperatureC": storage_temperature(), "gpuTemperatureC": gpu_temperature(),
        "memory": memory(),
        "filesystem": {"usedBytes": disk.used, "totalBytes": disk.total, "usedPercent": round(disk.used / disk.total * 100, 1)},
        "ipv4": ipv4(), "uptimeSeconds": int(float(read("/proc/uptime").split()[0])),
        "services": {}
    }


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            self.respond(200, {"status": "ok"})
        elif self.path == "/telemetry":
            self.respond(200, telemetry())
        else:
            self.respond(404, {"error": "not_found"})

    def respond(self, status, body):
        payload = json.dumps(body, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *_):
        pass


if __name__ == "__main__":
    ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), Handler).serve_forever()
