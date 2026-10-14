$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'polydaemon-session-args.ps1')
$controls = Get-PolyDaemonLauncherArgs -Raw $args
$Agent = $controls.Agent; $Workspace = $controls.Workspace; $Plan = $controls.Plan
$selection = Get-PolyDaemonSessionArgs -Arguments $controls.Arguments -Agent $Agent
$AgentArgs = @($selection.Arguments | Where-Object { $null -ne $_ })
Set-Location -LiteralPath $Workspace
$real = Resolve-PolyDaemonWorkspace $Workspace
$name = if ($env:TG_WS_NAME) { $env:TG_WS_NAME } else { (Split-Path (Get-Item -LiteralPath $Workspace).FullName -Leaf) -replace '[^\p{L}\p{Nd}._-]+','_' }
if ($Agent -eq 'claude' -and $selection.Management) {
    if ($Plan) {
        [PSCustomObject]@{ agent=$Agent; workspace=$real; fresh=$selection.New; command='claude.cmd'; arguments=$AgentArgs } | ConvertTo-Json -Depth 4
        exit 0
    }
    & claude.cmd @AgentArgs
    exit $LASTEXITCODE
}
$launch = @()
switch ($Agent) {
    'claude' {
        $history = Join-Path $env:USERPROFILE ('.claude/projects/' + ($real -replace '[^\p{L}\p{Nd}]', '-'))
        $continue = !$selection.New -and !$selection.ExplicitSelection -and !$selection.Management -and @(Get-ChildItem -LiteralPath $history -Filter '*.jsonl' -File -ErrorAction SilentlyContinue).Count -gt 0
        $launch = @('--dangerously-load-development-channels','server:tg-bridge')
        if ($continue) { $launch += '--continue' }
        $launch += @('--name',$name,'--permission-mode','bypassPermissions')
        $env:TG_BRIDGE_FORCE_CHANNELS = '1'
        $env:TG_WS_NAME = $name
        $env:TG_BRIDGE_INSTANCE_NAME = $name
        $env:DISABLE_AUTOUPDATER = '1'
        if (!$selection.Management -and $env:TG_KEEP_AUTOCOMPACT -cne '1' -and !@($AgentArgs | Where-Object { $_ -cmatch '^--settings(=|$)' }).Count) {
            $settings = Join-Path $env:USERPROFILE '.tg-bridge-channel\launch-no-autocompact.json'
            if (!$Plan) {
                New-Item -ItemType Directory -Path (Split-Path $settings) -Force | Out-Null
                Set-Content -LiteralPath $settings -Value '{"autoCompactEnabled":false}' -Encoding ascii -NoNewline
            }
            $launch += @('--settings',$settings)
        }
        $launch += $AgentArgs
        $env:CLAUDE_CODE_ENTRYPOINT = ''
        if (!$env:TG_WINDOW_UID) { $env:TG_WINDOW_UID = [guid]::NewGuid().ToString() }
        $command = 'claude.cmd'
    }
    'codex' {
        $command = Join-Path $PSScriptRoot 'polydaemon-codex.ps1'
        $launch = @()
        if ($selection.New) { $launch += 'new' }
        if ($controls.Check) { $launch += '-Check' }
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
if ($Agent -eq 'codex') {
    & $command -Workspace $Workspace @launch
} else {
    & $command @launch
}
exit $LASTEXITCODE
