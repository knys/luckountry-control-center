# Lightweight read-only Windows telemetry agent. Requires PowerShell 5.1+.
# Bind DEVICE_AGENT_PREFIX to the machine's LAN IPv4, then restrict the port to
# the local subnet with Windows Firewall. Default is loopback-only.
$ErrorActionPreference = "Stop"
$prefix = if ($env:DEVICE_AGENT_PREFIX) { $env:DEVICE_AGENT_PREFIX } else { "http://127.0.0.1:9100/" }
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add($prefix)
$listener.Start()

function Capacity($used, $total) {
    @{ usedBytes = [long]$used; totalBytes = [long]$total; usedPercent = if ($total) { [math]::Round($used / $total * 100, 1) } else { $null } }
}

function HardwareTemperatures {
    $temperatures = @{ cpu = $null; storage = $null; gpu = $null }
    foreach ($namespace in @("root/LibreHardwareMonitor", "root/OpenHardwareMonitor")) {
        try {
            $sensors = Get-CimInstance -Namespace $namespace -ClassName Sensor -ErrorAction Stop | Where-Object { $_.SensorType -eq "Temperature" }
            $cpu = $sensors | Where-Object { $_.Parent -match "cpu" -or $_.Name -match "CPU (Package|Core)" } | Measure-Object Value -Maximum
            $storage = $sensors | Where-Object { $_.Parent -match "(hdd|ssd|nvme)" -or $_.Name -match "(Drive|NVMe|SSD)" } | Measure-Object Value -Maximum
            $gpu = $sensors | Where-Object { $_.Parent -match "gpu" -or $_.Name -match "GPU" } | Measure-Object Value -Maximum
            if ($cpu.Count) { $temperatures.cpu = [double]$cpu.Maximum }
            if ($storage.Count) { $temperatures.storage = [double]$storage.Maximum }
            if ($gpu.Count) { $temperatures.gpu = [double]$gpu.Maximum }
            break
        } catch { }
    }
    if ($null -eq $temperatures.storage) {
        try {
            $storage = Get-CimInstance -Namespace root/Microsoft/Windows/Storage -ClassName MSFT_StorageReliabilityCounter -ErrorAction Stop | Measure-Object Temperature -Maximum
            if ($storage.Count -and [double]$storage.Maximum -gt 0) { $temperatures.storage = [double]$storage.Maximum }
        } catch { }
    }
    if ($null -eq $temperatures.gpu) {
        try {
            $gpu = & nvidia-smi --query-gpu=temperature.gpu --format=csv,noheader,nounits 2>$null | Measure-Object -Maximum
            if ($gpu.Count) { $temperatures.gpu = [double]$gpu.Maximum }
        } catch { }
    }
    $temperatures
}

function Telemetry {
    $os = Get-CimInstance Win32_OperatingSystem
    $cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
    $disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"
    $totalMemory = [long]$os.TotalVisibleMemorySize * 1024
    $freeMemory = [long]$os.FreePhysicalMemory * 1024
    $totalDisk = [long]$disk.Size
    $usedDisk = $totalDisk - [long]$disk.FreeSpace
    $address = Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike "127.*" -and $_.PrefixOrigin -ne "WellKnown" } | Select-Object -First 1 -ExpandProperty IPAddress
    $temperatures = HardwareTemperatures
    @{
        timestamp = [DateTime]::UtcNow.ToString("o")
        hostname = $env:COMPUTERNAME
        os = $os.Caption
        cpuUsagePercent = [double]$cpu.LoadPercentage
        cpuTemperatureC = $temperatures.cpu
        storageTemperatureC = $temperatures.storage
        gpuTemperatureC = $temperatures.gpu
        memory = Capacity ($totalMemory - $freeMemory) $totalMemory
        filesystem = Capacity $usedDisk $totalDisk
        ipv4 = $address
        uptimeSeconds = [long]([DateTime]::Now - $os.LastBootUpTime).TotalSeconds
        services = @{}
    }
}

try {
    while ($listener.IsListening) {
        $context = $listener.GetContext()
        $body = if ($context.Request.HttpMethod -ne "GET") {
            $context.Response.StatusCode = 405; @{ error = "method_not_allowed" }
        } elseif ($context.Request.Url.AbsolutePath -eq "/health") {
            @{ status = "ok" }
        } elseif ($context.Request.Url.AbsolutePath -eq "/telemetry") {
            Telemetry
        } else {
            $context.Response.StatusCode = 404; @{ error = "not_found" }
        }
        $bytes = [Text.Encoding]::UTF8.GetBytes(($body | ConvertTo-Json -Depth 5 -Compress))
        $context.Response.ContentType = "application/json; charset=utf-8"
        $context.Response.Headers["Cache-Control"] = "no-store"
        $context.Response.ContentLength64 = $bytes.Length
        $context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
        $context.Response.Close()
    }
} finally { $listener.Stop() }
