[CmdletBinding()]
param(
    [ValidateSet("Install", "Disable", "Uninstall")][string]$Action = "Install",
    [Parameter(Mandatory=$true)][string]$InstallDirectory,
    [string]$WorkspaceConfig,
    [string]$VerificationProfilesConfig,
    [string]$StateDirectory,
    [PSCredential]$ServiceCredential,
    [SecureString]$HmacSecret,
    [string]$NodeExecutable,
    [string]$WorkerId = "gtx1060",
    [string]$HmacKeyId = "lcc",
    [string]$BindAddress = "127.0.0.1",
    [int]$Port = 9200,
    [string]$Tx66kwhAddress,
    [string]$TaskName = "LuckountryControlCenterWorker"
)
$ErrorActionPreference = "Stop"
$firewallName = "Luckountry Control Center Worker 9200"
$runtimeDirectory = Join-Path $InstallDirectory ".worker-runtime"
$bootstrapPath = Join-Path $runtimeDirectory "start-worker.ps1"
$environmentPath = Join-Path $runtimeDirectory "environment.json"

if ($Port -eq 9100) { throw "Worker port 9200 must remain separate from telemetry port 9100" }

if ($Action -eq "Disable") {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Disable-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Out-Null
    return
}

if ($Action -eq "Uninstall") {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Remove-NetFirewallRule -DisplayName $firewallName -ErrorAction SilentlyContinue
    if (Test-Path $runtimeDirectory) { Remove-Item -LiteralPath $runtimeDirectory -Recurse -Force }
    return
}

if (-not $WorkspaceConfig -or -not (Test-Path -LiteralPath $WorkspaceConfig)) { throw "Workspace allowlist does not exist" }
if (-not $VerificationProfilesConfig -or -not (Test-Path -LiteralPath $VerificationProfilesConfig)) { throw "Verification profile config does not exist" }
if (-not $StateDirectory) { throw "StateDirectory is required" }
if (-not $Tx66kwhAddress) { throw "Tx66kwhAddress is required" }
if (-not $ServiceCredential -or -not $HmacSecret) { throw "ServiceCredential and HmacSecret are required for install" }
if ($ServiceCredential.UserName -notmatch "(?i)\\dev-codex$") { throw "Dedicated dev-codex account is required" }
if ($BindAddress -eq "0.0.0.0" -or $BindAddress -eq "::") { throw "Explicit LAN IPv4 or loopback is required" }
$parsedAddress = $null
if (-not [System.Net.IPAddress]::TryParse($BindAddress, [ref]$parsedAddress)) { throw "BindAddress must be an IP address" }
if (-not $NodeExecutable) { throw "NodeExecutable is required for install" }
if (-not [System.IO.Path]::IsPathRooted($NodeExecutable) -or -not (Test-Path -LiteralPath $NodeExecutable -PathType Leaf)) { throw "NodeExecutable must be an existing absolute file path" }
$nodeExecutable = (Resolve-Path -LiteralPath $NodeExecutable).Path
$account = $ServiceCredential.UserName
$workspaceManifest = Get-Content -LiteralPath $WorkspaceConfig -Raw | ConvertFrom-Json
if ($workspaceManifest.version -ne 1 -or -not $workspaceManifest.workspaces) { throw "Workspace allowlist is invalid" }
foreach ($workspace in @($workspaceManifest.workspaces)) {
    $workspacePath = [string]$workspace.path
    if (-not [System.IO.Path]::IsPathRooted($workspacePath) -or -not (Test-Path -LiteralPath $workspacePath -PathType Container)) { throw "Workspace path is unavailable" }
    icacls.exe $workspacePath /setowner $account /T /C | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Failed to set workspace owner" }
    icacls.exe $workspacePath /grant:r "${account}:(OI)(CI)M" /T /C | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Failed to grant workspace access" }
    $owner = (Get-Acl -LiteralPath $workspacePath).Owner
    if ($owner -ne $account) { throw "Workspace owner must match worker account" }
}

New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $StateDirectory -Force | Out-Null
$secret = [System.Net.NetworkCredential]::new("", $HmacSecret).Password
$environment = [ordered]@{
    WORKER_ID = $WorkerId
    WORKER_HMAC_KEY_ID = $HmacKeyId
    WORKER_HMAC_SECRET = $secret
    WORKER_WORKSPACES_CONFIG = (Resolve-Path $WorkspaceConfig).Path
    WORKER_STATE_PATH = (Join-Path $StateDirectory "executions.json")
    WORKER_VERIFICATION_PROFILES_CONFIG = (Resolve-Path $VerificationProfilesConfig).Path
    WORKER_VERIFICATION_STATE_PATH = (Join-Path $StateDirectory "verifications.json")
    WORKER_BIND_ADDRESS = $BindAddress
    WORKER_PORT = "$Port"
    WORKER_NODE_EXECUTABLE = $nodeExecutable
}
$environment | ConvertTo-Json | Set-Content -LiteralPath $environmentPath -Encoding UTF8
$secret = $null

$bootstrap = @'
$ErrorActionPreference = "Stop"
$runtimeDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$configuration = Get-Content -LiteralPath (Join-Path $runtimeDirectory "environment.json") -Raw | ConvertFrom-Json
foreach ($property in $configuration.PSObject.Properties) { [Environment]::SetEnvironmentVariable($property.Name, [string]$property.Value, "Process") }
$installDirectory = Split-Path -Parent $runtimeDirectory
$nodeExecutable = [string]$configuration.WORKER_NODE_EXECUTABLE
if (-not [System.IO.Path]::IsPathRooted($nodeExecutable) -or -not (Test-Path -LiteralPath $nodeExecutable -PathType Leaf)) { throw "Configured Node executable is unavailable" }
Set-Location $installDirectory
& $nodeExecutable (Join-Path $installDirectory "dist\worker\server.js")
exit $LASTEXITCODE
'@
$bootstrap | Set-Content -LiteralPath $bootstrapPath -Encoding UTF8

icacls.exe $runtimeDirectory /inheritance:r /grant:r "${account}:(OI)(CI)F" "SYSTEM:(OI)(CI)F" "Administrators:(OI)(CI)F" | Out-Null
$taskAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File `"$bootstrapPath`""
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 0) -StartWhenAvailable
$password = $ServiceCredential.GetNetworkCredential().Password
Register-ScheduledTask -TaskName $TaskName -Action $taskAction -Trigger $trigger -Settings $settings -User $account -Password $password -RunLevel Limited -Force | Out-Null
$password = $null

Remove-NetFirewallRule -DisplayName $firewallName -ErrorAction SilentlyContinue
if ($BindAddress -ne "127.0.0.1") {
    New-NetFirewallRule -DisplayName $firewallName -Direction Inbound -Action Allow -Protocol TCP -LocalAddress $BindAddress -LocalPort $Port -RemoteAddress $Tx66kwhAddress -Profile Private | Out-Null
}
Start-ScheduledTask -TaskName $TaskName
$health = $null
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Seconds 1
    try {
        $candidate = Invoke-RestMethod -Uri "http://$BindAddress`:$Port/v1/health" -TimeoutSec 2
        if ($candidate.status -eq "ok") { $health = $candidate; break }
    } catch {}
}
if (-not $health -or $health.status -ne "ok") {
    $taskInfo = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue
    $taskResult = if ($taskInfo) { $taskInfo.LastTaskResult } else { "unknown" }
    throw "Worker health check failed; scheduled task result=$taskResult"
}
$probeEnvironment = Get-Content -LiteralPath $environmentPath -Raw | ConvertFrom-Json
$timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds().ToString()
$nonce = [Guid]::NewGuid().ToString("N")
$sha256 = [Security.Cryptography.SHA256]::Create()
$emptyHash = ([BitConverter]::ToString($sha256.ComputeHash([Text.Encoding]::UTF8.GetBytes("")))).Replace("-", "").ToLowerInvariant()
$sha256.Dispose()
$canonical = "GET`n/v1/descriptor`n$timestamp`n$nonce`n$emptyHash"
$hmac = [Security.Cryptography.HMACSHA256]::new([Text.Encoding]::UTF8.GetBytes([string]$probeEnvironment.WORKER_HMAC_SECRET))
$signature = ([BitConverter]::ToString($hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($canonical)))).Replace("-", "").ToLowerInvariant()
$descriptor = Invoke-RestMethod -Uri "http://$BindAddress`:$Port/v1/descriptor" -Headers @{ "x-lcc-key-id"=$HmacKeyId;"x-lcc-timestamp"=$timestamp;"x-lcc-nonce"=$nonce;"x-lcc-signature"=$signature } -TimeoutSec 5
$hmac.Dispose();$signature=$null;$probeEnvironment=$null
if ($descriptor.workerId -ne $WorkerId -or -not $descriptor.codexReady) { throw "Worker descriptor readiness check failed" }
Write-Output ([ordered]@{ installed=$true; task=$TaskName; account=$account; port=$Port; telemetryPort=9100; health="PASS";descriptor="PASS" } | ConvertTo-Json -Compress)
