param(
    [Parameter(Mandatory)][ValidateSet('claude','codex','opencode','mimo')][string]$Agent,
    [Parameter(Mandatory)][string]$Workspace,
    [switch]$Plan,
    [Parameter(ValueFromRemainingArguments)][string[]]$AgentArgs
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'polydaemon-session-args.ps1')
$selection = Get-PolyDaemonSessionArgs -Arguments $AgentArgs
$AgentArgs = @($selection.Arguments | Where-Object { $null -ne $_ })
Set-Location -LiteralPath $Workspace
$physical = (Get-Item -LiteralPath $Workspace).ResolveLinkTarget($true)
$real = if ($physical) { $physical.FullName } else { (Get-Item -LiteralPath $Workspace).FullName }
$name = Split-Path (Get-Item -LiteralPath $Workspace).FullName -Leaf
$launch = @()
switch ($Agent) {
    'claude' {
        $history = Join-Path $env:USERPROFILE ('.claude/projects/' + ($real -replace '[:\\/]', '-'))
        $continue = !$selection.New -and @(Get-ChildItem -LiteralPath $history -Filter '*.jsonl' -File -ErrorAction SilentlyContinue).Count -gt 0
        $launch = @('--dangerously-load-development-channels','server:tg-bridge')
        if ($continue) { $launch += '--continue' }
        $launch += @('--name',$name,'--permission-mode','bypassPermissions') + $AgentArgs
        $env:TG_BRIDGE_FORCE_CHANNELS = '1'
        $env:CLAUDE_CODE_ENTRYPOINT = ''
        if (!$env:TG_WINDOW_UID) { $env:TG_WINDOW_UID = [guid]::NewGuid().ToString() }
        $command = 'claude.cmd'
    }
    'codex' {
        $command = Join-Path $PSScriptRoot 'polydaemon-codex.ps1'
        $launch = @('-Workspace',$Workspace)
        if ($selection.New) { $launch += 'new' }
        $launch += $AgentArgs
    }
    default {
        if ($selection.New) {
            if ($Agent -eq 'mimo') { $env:TG_MIMO_NEW = '1' } else { $env:TG_OPENCODE_NEW = '1' }
        }
        $command = 'bun'
        $launch = @('run',(Join-Path $PSScriptRoot "$Agent-launch.ts")) + $AgentArgs
    }
}
if ($Plan) {
    [PSCustomObject]@{ agent=$Agent; workspace=$real; fresh=$selection.New; command=$command; arguments=$launch; mimoNew=$env:TG_MIMO_NEW; opencodeNew=$env:TG_OPENCODE_NEW } | ConvertTo-Json -Depth 4
    exit 0
}
& $command @launch
exit $LASTEXITCODE
