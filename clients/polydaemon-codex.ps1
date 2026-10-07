param(
    [Parameter(Mandatory)][string]$Workspace,
    [switch]$Check,
    [Parameter(ValueFromRemainingArguments)][string[]]$CodexArgs
)
$ErrorActionPreference = 'Stop'
$codexCommand = (Get-Command codex.cmd -ErrorAction Stop).Source
$management = @('mcp','app-server','doctor','login','logout','features','plugin','completion','update','exec','review','queue','sandbox','debug')
if ($CodexArgs.Count -gt 0 -and ($management -contains $CodexArgs[0] -or $CodexArgs[0] -in @('--help','-h','--version','-V'))) {
    & $codexCommand --cd $Workspace @CodexArgs
    exit $LASTEXITCODE
}
if ($CodexArgs -contains '--no-daemon') {
    Write-Host 'polydaemon-codex: ignoring --no-daemon; Telegram uses the bridge app-server.'
    $CodexArgs = @($CodexArgs | Where-Object { $_ -ne '--no-daemon' })
}
$npmRoot = Join-Path (Split-Path $codexCommand) 'node_modules\@openai\codex'
$codexExe = @(Get-ChildItem -LiteralPath $npmRoot -Filter codex.exe -Recurse -File)
if ($codexExe.Count -ne 1) { throw 'Cannot resolve one native Codex executable from npm installation' }
$bun = (Get-Command bun -ErrorAction Stop).Source
function AgentHealthy {
    try { return (Invoke-RestMethod -Uri 'http://127.0.0.1:3200/v1/health' -TimeoutSec 2).ok } catch { return $false }
}
if (!(AgentHealthy)) {
    $runner = Join-Path $PSScriptRoot 'start-agentd.ps1'
    $ps = (Get-Process -Id $PID).Path
    $runnerArgs = @('-NoProfile','-File',('"{0}"' -f $runner),'-CodexExe',('"{0}"' -f $codexExe[0].FullName),'-BunExe',('"{0}"' -f $bun))
    Start-Process -FilePath $ps -ArgumentList $runnerArgs -WindowStyle Hidden | Out-Null
}
$ready = $false
for ($i=0; $i -lt 30; $i++) {
    try {
        $agent = Get-Content -LiteralPath (Join-Path $env:USERPROFILE '.tg-bridge\agent.toml') -Raw
        $token = [regex]::Match($agent, '(?m)^auth_token\s*=\s*"([^"]+)"').Groups[1].Value
        $status = Invoke-RestMethod -Uri 'http://127.0.0.1:3200/v1/codex/status' -Headers @{Authorization="Bearer $token"} -TimeoutSec 2
        if ($status.app_server -eq 'up') { $ready = $true; break }
    } catch {}
    Start-Sleep -Milliseconds 500
}
if (!$ready) { throw 'Bridge app-server not ready; inspect ~/.tg-bridge/agentd.log' }
Set-Location -LiteralPath $Workspace
if ($Check) {
    Write-Output ('CLI: ' + $codexCommand)
    Write-Output ('Launch: --remote ws://127.0.0.1:3210 --cd "' + $Workspace + '" ' + ($CodexArgs -join ' '))
    exit 0
}
& $codexCommand --remote ws://127.0.0.1:3210 --cd $Workspace @CodexArgs
exit $LASTEXITCODE
