param([Parameter(Mandatory)][string]$CodexExe, [Parameter(Mandatory)][string]$BunExe)
$ErrorActionPreference = 'Stop'
$mutex = [Threading.Mutex]::new($false, 'Local\tg-bridge-agentd')
if (!$mutex.WaitOne(0)) { exit 0 }
try {
    $env:TG_CODEX_BIN = $CodexExe
    $state = Join-Path $env:USERPROFILE '.tg-bridge'
    [IO.Directory]::CreateDirectory($state) | Out-Null
    Set-Location -LiteralPath $env:USERPROFILE
    $agent = Join-Path $PSScriptRoot '..\agent\agentd.ts'
    while ($true) {
        & $BunExe run $agent >> (Join-Path $state 'agentd.log') 2>&1
        Start-Sleep -Seconds 3
    }
} finally {
    $mutex.ReleaseMutex()
    $mutex.Dispose()
}
