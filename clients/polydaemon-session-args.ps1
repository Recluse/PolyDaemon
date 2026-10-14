function Get-PolyDaemonValueOptions {
    param([string]$Agent)
    if ($Agent -eq 'codex') {
        return @('-c','--config','-s','--sandbox','-a','--ask-for-approval','-C','--cd',
                 '-m','--model','-p','--profile','-i','--image','--remote',
                 '--remote-auth-token-env','--local-provider','--enable','--disable','--add-dir')
    }
    return @('--model','-m','--settings','--name','--permission-mode','--max-turns',
             '--max-budget-usd','--mcp-config','--allowedTools','--disallowedTools',
             '--append-system-prompt','--system-prompt','--output-format','--input-format',
             '--session','--session-id','--resume','-r','--port','--hostname')
}

function Get-PolyDaemonLauncherArgs {
    param([object[]]$Raw, [string]$DefaultAgent)
    # Script param() abbreviations consume native -c/-p/-a as Check/Plan/Agent.
    # Recognize only exact documented launcher controls, never abbreviations.
    $workspace = $null; $agent = $DefaultAgent; $plan = $false; $check = $false
    $rest = [Collections.Generic.List[string]]::new()
    for ($i = 0; $i -lt $Raw.Count; $i++) {
        $arg = [string]$Raw[$i]
        if ($arg -ceq '--') {
            for (; $i -lt $Raw.Count; $i++) { $rest.Add([string]$Raw[$i]) }
            break
        }
        if ($arg -ieq '-Workspace' -or (!$DefaultAgent -and $arg -ieq '-Agent')) {
            if (++$i -ge $Raw.Count) { throw "Missing value for $arg" }
            if ($arg -ieq '-Workspace') { $workspace = [string]$Raw[$i] }
            else { $agent = [string]$Raw[$i] }
        } elseif ($arg -ieq '-Plan') { $plan = $true }
        elseif ($arg -ieq '-Check') { $check = $true }
        else {
            $rest.Add($arg)
            if ((Get-PolyDaemonValueOptions $agent) -ccontains $arg) {
                if ($i + 1 -lt $Raw.Count) { $rest.Add([string]$Raw[++$i]) }
            }
        }
    }
    if (!$workspace) { throw 'Specify -Workspace <folder>' }
    if (@('claude','codex','opencode','mimo') -notcontains $agent) { throw 'Specify a supported -Agent' }
    [PSCustomObject]@{ Workspace=$workspace; Agent=$agent; Plan=$plan; Check=$check; Arguments=$rest.ToArray() }
}

function Get-PolyDaemonSessionArgs {
    param([string[]]$Arguments, [string]$Agent)
    $literalNew = $Arguments.Count -gt 0 -and $Arguments[0] -ceq 'new'
    if ($literalNew) { $rest = @($Arguments | Select-Object -Skip 1) } else { $rest = @($Arguments) }
    $freshEnv = if ($Agent) { [Environment]::GetEnvironmentVariable('TG_' + $Agent.ToUpperInvariant() + '_NEW') } else { '' }
    $fresh = $literalNew -or $freshEnv -ceq '1'
    $explicit = $false; $management = $false; $positional = $null
    $short = switch ($Agent) { 'codex' { @('-r') }; 'claude' { @('-c','-r') }; default { @('-s','-r','-c') } }
    for ($i = 0; $i -lt $rest.Count; $i++) {
        $arg = $rest[$i]
        if ($arg -ceq '--') { break }
        if (@('--help','-h','--version','-V') -ccontains $arg -or ($Agent -eq 'claude' -and $arg -ceq '-v')) { $management = $true }
        if ($arg -cmatch '^--(session|session-id|resume|continue|fork|fork-session)(=|$)' -or $short -ccontains $arg) { $explicit = $true }
        if ((Get-PolyDaemonValueOptions $Agent) -ccontains $arg) { $i++; continue }
        if (!$positional -and $arg -and !$arg.StartsWith('-')) { $positional = $arg }
    }
    if (@('resume','continue','fork') -ccontains $positional) { $explicit = $true }
    if ($Agent -eq 'codex' -and @('agents','mcp','app-server','doctor','login','logout','features','plugin',
        'completion','update','exec','e','review','queue','sandbox','debug','apply','a','app','archive',
        'delete','unarchive','migrate-rollouts','cloud','exec-server','remote-control','help') -ccontains $positional) { $management = $true }
    if ($fresh -and $explicit) { throw 'new cannot be combined with session/resume/continue/fork selection' }
    [PSCustomObject]@{ New=[bool]$fresh; ExplicitSelection=$explicit; Management=$management; Arguments=[string[]]$rest }
}

function Resolve-PolyDaemonWorkspace {
    param([string]$Folder, [int]$Depth = 0)
    if ($Depth -gt 64) { throw 'Workspace link resolution exceeded safe depth' }
    $item = Get-Item -LiteralPath $Folder -Force -ErrorAction Stop
    if (!$item.PSIsContainer) { throw 'Workspace must be a directory' }
    if ($item.Target) {
        $target = [string]@($item.Target)[0]
        if (![IO.Path]::IsPathRooted($target)) { $target = Join-Path $item.Parent.FullName $target }
        return Resolve-PolyDaemonWorkspace -Folder $target -Depth ($Depth + 1)
    }
    if ($item.Parent) {
        return Join-Path (Resolve-PolyDaemonWorkspace -Folder $item.Parent.FullName -Depth ($Depth + 1)) $item.Name
    }
    return $item.FullName
}
