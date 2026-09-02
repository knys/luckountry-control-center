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

function Telemetry {
    $os = Get-CimInstance Win32_OperatingSystem
    $cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
    $disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"
    $totalMemory = [long]$os.TotalVisibleMemorySize * 1024
    $freeMemory = [long]$os.FreePhysicalMemory * 1024
    $totalDisk = [long]$disk.Size
    $usedDisk = $totalDisk - [long]$disk.FreeSpace
    $address = Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike "127.*" -and $_.PrefixOrigin -ne "WellKnown" } | Select-Object -First 1 -ExpandProperty IPAddress
    @{
        timestamp = [DateTime]::UtcNow.ToString("o")
        hostname = $env:COMPUTERNAME
        os = $os.Caption
        cpuUsagePercent = [double]$cpu.LoadPercentage
        cpuTemperatureC = $null # Standard Windows APIs do not reliably expose CPU package temperature.
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
