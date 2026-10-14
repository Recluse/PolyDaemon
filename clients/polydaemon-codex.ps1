$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'polydaemon-session-args.ps1')
$controls = Get-PolyDaemonLauncherArgs -Raw $args -DefaultAgent codex
$Workspace = Resolve-PolyDaemonWorkspace $controls.Workspace
$Check = $controls.Check; $Plan = $controls.Plan
$selection = Get-PolyDaemonSessionArgs -Arguments $controls.Arguments -Agent codex
$CodexArgs = @($selection.Arguments | Where-Object { $null -ne $_ })
if ($selection.Management) {
    if ($Plan -or $Check) {
        [PSCustomObject]@{ fresh=$selection.New; session_mode='management'; arguments=@('--cd',$Workspace) + $CodexArgs } | ConvertTo-Json -Depth 4
        exit 0
    }
    $codexCommand = (Get-Command codex.cmd -ErrorAction Stop).Source
    & $codexCommand --cd $Workspace @CodexArgs
    exit $LASTEXITCODE
}
$wsPort = if ($env:TG_CODEX_WS_PORT) { $env:TG_CODEX_WS_PORT } else { '3210' }
if ($wsPort -notmatch '^\d+$' -or [int]$wsPort -lt 1 -or [int]$wsPort -gt 65535) { throw 'Invalid TG_CODEX_WS_PORT' }
$ws = 'ws://127.0.0.1:' + $wsPort
function Read-AgentConfig {
    $path = Join-Path $env:USERPROFILE '.tg-bridge\agent.toml'
    if (!(Test-Path -LiteralPath $path)) { throw 'Missing ~/.tg-bridge/agent.toml; cannot select a saved Codex thread' }
    $agent = Get-Content -LiteralPath $path -Raw
    $token = [regex]::Match($agent, '(?m)^\s*auth_token\s*=\s*"([^"]+)"').Groups[1].Value
    $port = [regex]::Match($agent, '(?m)^\s*port\s*=\s*(\d+)\s*(?:#.*)?$').Groups[1].Value
    if (!$port) { $port = '3200' }
    if (!$token -or [int]$port -lt 1 -or [int]$port -gt 65535) { throw 'Invalid daemon port/auth in ~/.tg-bridge/agent.toml' }
    return @{ Base='http://127.0.0.1:' + $port; Token=$token }
}
function Get-InteractiveArguments {
    $prefix = @('--remote',$ws)
    if ($env:TG_CODEX_CHECK_UPDATE -ceq '0') { $prefix += @('-c','check_for_update_on_startup=false') }
    if (!$selection.New -and !$selection.ExplicitSelection) {
        $cfg = Read-AgentConfig
        try {
            $result = Invoke-RestMethod -Uri ($cfg.Base + '/v1/codex/last-thread?cwd=' + [Uri]::EscapeDataString($Workspace)) -Headers @{Authorization=('Bearer ' + $cfg.Token)} -TimeoutSec 4
        } catch { throw "Codex last-thread lookup failed for '$Workspace'; refusing to silently start fresh. Check the daemon/authentication." }
        if ($null -eq $result) { throw 'Invalid Codex last-thread response; refusing to silently start fresh' }
        $hasId = if ($result -is [Collections.IDictionary]) { $result.Contains('thread_id') } else { $null -ne $result.PSObject.Properties['thread_id'] }
        if (($result.ok -is [bool] -and !$result.ok) -or !$hasId) { throw 'Invalid Codex last-thread response; refusing to silently start fresh' }
        if ($null -ne $result.thread_id -and $result.thread_id -isnot [string]) { throw 'Invalid saved Codex thread ID' }
        if ($result.thread_id -is [string] -and $result.thread_id.Length -gt 0) {
            if ($result.thread_id -notmatch '\A[a-zA-Z0-9-]+\z') { throw 'Invalid saved Codex thread ID' }
            $prefix += @('resume',$result.thread_id)
        }
    }
    return $prefix + @('--cd',$Workspace) + $CodexArgs
}
if ($Plan) {
    [PSCustomObject]@{ fresh=$selection.New; arguments=@(Get-InteractiveArguments) } | ConvertTo-Json -Depth 4
    exit 0
}
$codexCommand = (Get-Command codex.cmd -ErrorAction Stop).Source
if ($CodexArgs -contains '--no-daemon') {
    Write-Host 'polydaemon-codex: ignoring --no-daemon; Telegram uses the bridge app-server.'
    $CodexArgs = @($CodexArgs | Where-Object { $_ -ne '--no-daemon' })
}
$npmRoot = Join-Path (Split-Path $codexCommand) 'node_modules\@openai\codex'
$codexExe = @(Get-ChildItem -LiteralPath $npmRoot -Filter codex.exe -Recurse -File)
if ($codexExe.Count -ne 1) { throw 'Cannot resolve one native Codex executable from npm installation' }
$bun = (Get-Command bun -ErrorAction Stop).Source
function AgentHealthy {
    try {
        $path = Join-Path $env:USERPROFILE '.tg-bridge\agent.toml'
        $base = if (Test-Path -LiteralPath $path) { (Read-AgentConfig).Base } else { 'http://127.0.0.1:3200' }
        return (Invoke-RestMethod -Uri ($base + '/v1/health') -TimeoutSec 2).ok
    } catch { return $false }
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
        $cfg = Read-AgentConfig
        $status = Invoke-RestMethod -Uri ($cfg.Base + '/v1/codex/status') -Headers @{Authorization=('Bearer ' + $cfg.Token)} -TimeoutSec 2
        if ($status.app_server -eq 'up') { $ready = $true; break }
    } catch {}
    Start-Sleep -Milliseconds 500
}
if (!$ready) { throw 'Bridge app-server not ready; inspect ~/.tg-bridge/agentd.log' }
Set-Location -LiteralPath $Workspace
$interactiveArgs = @(Get-InteractiveArguments)
if ($Check) {
    Write-Output ('CLI: ' + $codexCommand)
    Write-Output ('Launch: ' + ($interactiveArgs -join ' '))
    exit 0
}
& $codexCommand @interactiveArgs
exit $LASTEXITCODE
