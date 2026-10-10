function Get-PolyDaemonSessionArgs {
    param([string[]]$Arguments)
    $fresh = $Arguments.Count -gt 0 -and $Arguments[0] -ceq 'new'
    $rest = if ($fresh) { @($Arguments | Select-Object -Skip 1) } else { @($Arguments) }
    if ($fresh -and @($rest | Where-Object { $_ -match '^(resume|continue|fork|--(session|resume|continue|fork|fork-session)(=|$)|-[src]$)' }).Count) {
        throw 'new cannot be combined with session/resume/continue/fork selection'
    }
    [PSCustomObject]@{ New = $fresh; Arguments = [string[]]$rest }
}
