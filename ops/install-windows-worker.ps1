param(
    [Parameter(Mandatory=$true)][string]$InstallDirectory,
    [Parameter(Mandatory=$true)][string]$WorkspaceConfig,
    [Parameter(Mandatory=$true)][string]$StatePath,
    [string]$BindAddress = "127.0.0.1",
    [int]$Port = 9200,
    [string]$AllowedRemoteAddress = "LocalSubnet"
)
$ErrorActionPreference = "Stop"
if ($Port -eq 9100) { throw "Execution worker must not use telemetry port 9100" }
if (-not (Test-Path $WorkspaceConfig)) { throw "Workspace allowlist does not exist" }
Write-Host "Configure WORKER_ID, WORKER_HMAC_KEY_ID, and WORKER_HMAC_SECRET in the service account's protected environment."
Write-Host "Start with: node $InstallDirectory\dist\worker\server.js"
if ($BindAddress -ne "127.0.0.1") {
    New-NetFirewallRule -DisplayName "Luckountry execution worker" -Direction Inbound -Action Allow -Protocol TCP -LocalAddress $BindAddress -LocalPort $Port -RemoteAddress $AllowedRemoteAddress -Profile Private
}
