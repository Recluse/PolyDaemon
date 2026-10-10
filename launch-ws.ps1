<#
launch-ws.ps1 — open a workspace's selected PolyDaemon agent in a visible console.

The instance connects to the tg-bridge by --name (= its folder), registers, and the
Python bot auto-creates/binds its forum topic (topic-bindings.json keyed by cwd) — so
the whole conversation for that workspace lives in its own Telegram topic.

Usage:  launch-ws.ps1 <workspace-name>     # e.g. launch-ws.ps1 my-project
        launch-ws.ps1 <name> -Dir <folder> -Agent codex -NewSession
                                            # exact folder; missing launcher fails
        launch-ws.ps1 -List                # list launchable workspaces

Workspace root: -WorkspaceRoot, else $env:TG_WS_ROOT, else <system drive>\Work.
#>
param(
  [Parameter(Position = 0)][string]$Name,
  [switch]$List,
  [string]$Dir,            # the workspace folder itself, when the caller knows it
  [ValidateSet('claude','codex','opencode','mimo')][string]$Agent = 'claude',
  [switch]$NewSession,
  [switch]$Check,          # read-only plan: no process, settings write or keypress
  [int]$Enter = 2,         # presses to send into the new window once the TUI is up
  [int]$DelaySec = 0,      # extra wait before the first screen read. Was 10: a fixed
                           # sleep before even LOOKING, which is most of why a
                           # Windows launch felt slow next to the Mac one (that one
                           # polls from second zero). The screen loop below already
                           # waits for the prompt to appear, and the blind-Enter
                           # fallback only fires after that whole loop, so dropping
                           # this cannot make blind Enters land early. Kept as a
                           # knob for a box where claude is unusually slow to draw.
  [int]$ResumeChoice = 2,  # on --continue of an old session, claude shows a "Resume
                           # from summary (1) / full session (2) / don't ask (3)"
                           # dialog. Auto-pick this option (2 = full session as-is).
                           # 0 disables the handling. Only fires when the dialog is
                           # actually on screen (screen-read guarded), so it never
                           # injects arrows into a normal prompt.
  [switch]$KeepAutoCompact,  # by default we DISABLE claude's auto-compact for the
                           # launched window — a full-session resume otherwise gets
                           # compacted immediately, undoing the point of picking
                           # "full session". We pass --settings {autoCompactEnabled:
                           # false} through polydaemon-claude.cmd's %*. (The
                           # CLAUDE_CODE_AUTO_COMPACT_WINDOW env only sets a NUMERIC
                           # threshold and silently ignores non-numeric values, so it
                           # can't turn auto-compact off.) Pass -KeepAutoCompact to
                           # leave it on.
  [switch]$NoMinimize,     # by default the console is minimized once the startup
                           # prompts are handled (a no-op under Windows Terminal,
                           # which owns the window — see the end of the script)
  # Folder that holds the workspaces, one subfolder each. Not hardcoded: the
  # layout is per-machine, and baking one person's folder in means everyone else
  # silently gets an empty workspace list. Precedence: this parameter, then
  # $env:TG_WS_ROOT, then a Work folder on the system drive.
  [string]$WorkspaceRoot = $(if ($env:TG_WS_ROOT) { $env:TG_WS_ROOT } else { Join-Path $env:SystemDrive 'Work' })
)

$ErrorActionPreference = 'Stop'
$launcherNames = @("polydaemon-$Agent.cmd")
if ($Agent -eq 'claude') { $launcherNames += 'tg-claude.cmd' }
function Has-Launcher([string]$Folder) {
  foreach ($launcher in $launcherNames) {
    if (Test-Path -LiteralPath (Join-Path $Folder $launcher)) { return $true }
  }
  return $false
}
function Physical-Path([string]$Folder) {
  $item = Get-Item -LiteralPath $Folder -ErrorAction Stop
  for ($i=0; $i -lt 8 -and $item.Target; $i++) {
    $item = Get-Item -LiteralPath @($item.Target)[0] -ErrorAction Stop
  }
  return $item.FullName.TrimEnd('\','/').Replace('/','\')
}

# Discover every folder under $WorkspaceRoot (depth<=4) that has a polydaemon-claude.cmd.
# NB: -Recurse does not descend into junctions/symlinks — probe top-level
# reparse points explicitly (a junction workspace is a named alias of another
# one: window name = folder basename).
function Get-Workspaces {
  $found = Get-ChildItem -Path $WorkspaceRoot -Recurse -Depth 4 -Include $launcherNames -File -ErrorAction SilentlyContinue |
    ForEach-Object { [pscustomobject]@{ Name = $_.Directory.Name; Path = $_.Directory.FullName } }
  $junctions = Get-ChildItem -Path $WorkspaceRoot -Directory -ErrorAction SilentlyContinue |
    Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -and (Has-Launcher $_.FullName) } |
    ForEach-Object { [pscustomobject]@{ Name = $_.Name; Path = $_.FullName } }
  @($found) + @($junctions) | Sort-Object Path -Unique
}

# A known folder skips the scan entirely; missing launcher fails without fallback.
# A plain string, not Join-Path: PowerShell 5.1's Join-Path throws on a drive that
# is not mounted (an unplugged disk), which under ErrorAction Stop killed the
# script before the name-search fallback below could run.
if ($Dir -and -not $List) {
  if (!(Has-Launcher $Dir)) { throw "Exact workspace '$Dir' has no $Agent launcher" }
  $workspaces = @([pscustomobject]@{ Name = (Split-Path $Dir -Leaf); Path = (Resolve-Path -LiteralPath $Dir).Path })
  $Name = $workspaces[0].Name
} else {
  $workspaces = Get-Workspaces
}

if ($List -or -not $Name) {
  Write-Output "Launchable workspaces for ${Agent}:"
  $workspaces | ForEach-Object { Write-Output ('  {0,-22} {1}' -f $_.Name, $_.Path) }
  return
}

$match = @($workspaces | Where-Object { $_.Name -ieq $Name })
if (-not $match) {
  Write-Error "workspace '$Name' not found. Run with -List to see options."
  exit 1
}
if ($match.Count -gt 1) {
  Write-Error "ambiguous '$Name' -> $($match.Path -join ', '). Pass a full unique name."
  exit 1
}

$dir = $match[0].Path
$cmdPath = Join-Path $dir "polydaemon-$Agent.cmd"
if (-not (Test-Path -LiteralPath $cmdPath)) {
  if ($Agent -ne 'claude' -or $NewSession) { throw 'Install the canonical launcher before requesting this agent/new session' }
  $cmdPath = Join-Path $dir 'tg-claude.cmd'
}
# Match both workspace and agent; never stop an existing process or another agent.
$registryPath = Join-Path $env:USERPROFILE '.tg-bridge-channel\instances.json'
if (Test-Path -LiteralPath $registryPath) {
  try { $registry = Get-Content -LiteralPath $registryPath -Raw | ConvertFrom-Json }
  catch { throw 'Cannot inspect local bridge ownership registry; retry after its writer finishes' }
  foreach ($entry in $registry.PSObject.Properties) {
    $row = $entry.Value
    $key = if ($row.instance_name) { $row.instance_name } else { $row.workspace_name }
    $rowAgent = if ($key -match '-(codex|opencode|mimo)$') { $Matches[1] } else { 'claude' }
    if ($rowAgent -ne $Agent -or !$row.cwd) { continue }
    try { $same = (Physical-Path $row.cwd) -ieq (Physical-Path $dir) } catch { continue }
    if ($same -and $row.pid -gt 1 -and $row.parent_pid -gt 1 -and
        (Get-Process -Id $row.pid -ErrorAction SilentlyContinue) -and
        (Get-Process -Id $row.parent_pid -ErrorAction SilentlyContinue)) {
      throw "A live $Agent bridge window already owns '$dir'; use or close that window"
    }
  }
}

# Disable claude's auto-compact for THIS launched window. Without it, a full-session
# resume gets auto-compacted immediately, defeating the "Resume full session" choice.
# The real lever is the boolean setting `autoCompactEnabled:false` (the
# CLAUDE_CODE_AUTO_COMPACT_WINDOW env only sets a NUMERIC threshold and silently
# ignores non-numeric input). We write a tiny settings overlay and pass it via
# claude's `--settings <file>` (it merges on top of normal settings), forwarded
# through polydaemon-claude.cmd's `%*`. A file path (no spaces) sidesteps cmd quote-mangling
# that inline JSON braces/quotes would hit. Scoped to launched windows; global
# settings untouched.
$extraArgs = @()
if ($NewSession) { $extraArgs += 'new' }
if ($Agent -eq 'claude' -and -not $KeepAutoCompact) {
  $settingsPath = Join-Path $env:USERPROFILE '.tg-bridge-channel\launch-no-autocompact.json'
  try {
    $settingsDir = Split-Path $settingsPath -Parent
    if (!$Check) {
      if (-not (Test-Path $settingsDir)) { New-Item -ItemType Directory -Path $settingsDir -Force | Out-Null }
      Set-Content -Path $settingsPath -Value '{"autoCompactEnabled":false}' -Encoding ascii -NoNewline
    }
    $extraArgs += @('--settings', $settingsPath)
  } catch { Write-Output "warn: could not write auto-compact settings: $_" }
}

# Pass the FULL path to the .cmd (a bare name resolves against cmd's own cwd, not $dir,
# and launched the wrong workspace). polydaemon-claude.cmd cd's to its own dir via %~dp0.
# cmd /k keeps the window open after claude exits. Extra args after the .cmd path
# flow into polydaemon-claude.cmd's %* and on to claude.
$commandLine = '"' + $cmdPath + '"' + (($extraArgs | ForEach-Object { ' "' + $_ + '"' }) -join '')
if ($Check) {
  [PSCustomObject]@{ agent=$Agent; workspace=$dir; launcher=$cmdPath; arguments=$extraArgs; nudge=($Agent -eq 'claude'); new_session=[bool]$NewSession; commandLine=$commandLine } | ConvertTo-Json -Depth 4
  return
}
$proc = Start-Process -FilePath 'cmd.exe' -ArgumentList ('/d /s /k "' + $commandLine + '"') `
  -WorkingDirectory $dir -WindowStyle Normal -PassThru
Write-Output "launched '$($match.Name)' (pid $($proc.Id)) -> $cmdPath"

# Nudge the TUI: once claude is up, inject Enters straight into the new
# console's INPUT BUFFER (AttachConsole + WriteConsoleInput). The previous
# AppActivate+SendKeys approach needed the window to take foreground focus —
# Windows denies that to background/hidden processes (and the bot launches
# this script from a hidden powershell), so the Enters either vanished or
# landed in whatever app the user was typing in. WriteConsoleInput needs no
# focus at all and can't leak keystrokes elsewhere.
if ($Agent -eq 'claude' -and ($Enter -gt 0 -or $ResumeChoice -ge 1)) {
  Add-Type -ErrorAction Stop @"
using System; using System.Runtime.InteropServices; using System.Text;
public class ConIn {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr CreateFile(
    string name, uint access, uint share, IntPtr sec, uint disp, uint flags, IntPtr tmpl);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct KEY_EVENT_RECORD {
    public int bKeyDown; public ushort wRepeatCount; public ushort wVirtualKeyCode;
    public ushort wVirtualScanCode; public char uChar; public uint dwControlKeyState;
  }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT_RECORD {
    public ushort EventType; public KEY_EVENT_RECORD KeyEvent;
  }
  [StructLayout(LayoutKind.Sequential)] public struct COORD { public short X; public short Y; }
  [StructLayout(LayoutKind.Sequential)] public struct SMALL_RECT { public short Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct CONSOLE_SCREEN_BUFFER_INFO {
    public COORD dwSize; public COORD dwCursorPosition; public ushort wAttributes;
    public SMALL_RECT srWindow; public COORD dwMaximumWindowSize;
  }
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool WriteConsoleInput(
    IntPtr h, INPUT_RECORD[] recs, uint len, out uint written);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetConsoleScreenBufferInfo(
    IntPtr h, out CONSOLE_SCREEN_BUFFER_INFO info);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] public static extern bool ReadConsoleOutputCharacter(
    IntPtr h, [Out] StringBuilder buf, uint len, COORD coord, out uint read);

  // Inject one key (down+up) into pid's console input buffer. ctrl carries
  // ENHANCED_KEY (0x100) for the arrow keys so the console emits the proper
  // VT escape (ESC [ B) that claude's TUI reads.
  public static string SendKey(uint pid, ushort vk, ushort scan, char ch, uint ctrl) {
    FreeConsole();  // a process can hold only one console; drop ours if any
    if (!AttachConsole(pid)) return "AttachConsole failed: " + Marshal.GetLastWin32Error();
    try {
      IntPtr h = CreateFile("CONIN$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
      if (h == (IntPtr)(-1)) return "CONIN$ open failed: " + Marshal.GetLastWin32Error();
      var recs = new INPUT_RECORD[2];
      recs[0].EventType = 1; // KEY_EVENT
      recs[0].KeyEvent.bKeyDown = 1; recs[0].KeyEvent.wRepeatCount = 1;
      recs[0].KeyEvent.wVirtualKeyCode = vk; recs[0].KeyEvent.wVirtualScanCode = scan;
      recs[0].KeyEvent.uChar = ch; recs[0].KeyEvent.dwControlKeyState = ctrl;
      recs[1] = recs[0]; recs[1].KeyEvent.bKeyDown = 0;
      uint written;
      if (!WriteConsoleInput(h, recs, 2, out written)) return "WriteConsoleInput failed: " + Marshal.GetLastWin32Error();
      return "ok";
    } finally { FreeConsole(); }
  }
  public static string SendEnter(uint pid) { return SendKey(pid, 0x0D, 0x1C, '\r', 0); }
  public static string SendDown(uint pid)  { return SendKey(pid, 0x28, 0x50, '\0', 0x100); } // VK_DOWN, ENHANCED_KEY

  // Snapshot pid's visible console text (so we can detect WHICH dialog is up
  // before injecting keys). Returns "" on any failure — caller treats that as
  // "dialog not detected" and degrades to the blind-Enter nudge.
  public static string ReadScreen(uint pid) {
    FreeConsole();
    if (!AttachConsole(pid)) return "";
    try {
      IntPtr h = CreateFile("CONOUT$", 0x80000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero); // GENERIC_READ
      if (h == (IntPtr)(-1)) return "";
      CONSOLE_SCREEN_BUFFER_INFO info;
      if (!GetConsoleScreenBufferInfo(h, out info)) return "";
      // Read only the VISIBLE viewport (srWindow), not the whole buffer. The full
      // buffer keeps scrollback, so a dialog that was already dismissed and scrolled
      // up would still match — and we'd inject keys into the live prompt below it
      // (e.g. recalling history). The viewport always reflects what's on screen now.
      int top = info.srWindow.Top;
      int rows = info.srWindow.Bottom - info.srWindow.Top + 1;
      if (rows <= 0) { top = 0; rows = info.dwSize.Y; }
      int cells = info.dwSize.X * rows;
      if (cells <= 0 || cells > 2000000) return "";
      var sb = new StringBuilder(cells);
      uint read; COORD origin; origin.X = 0; origin.Y = (short)top;
      if (!ReadConsoleOutputCharacter(h, sb, (uint)cells, origin, out read)) return "";
      return sb.ToString(0, (int)read);
    } finally { FreeConsole(); }
  }
}
"@
  Start-Sleep -Seconds $DelaySec

  # Screen-driven startup handler. On `--continue --dangerously-load-development-
  # channels` claude shows a SEQUENCE of blocking prompts, each gating the next,
  # with timing that varies as MCP servers connect:
  #   0. folder trust — only for a folder claude has not seen before, and with
  #      "No, exit" HIGHLIGHTED; "Yes, I trust this folder" -> Down + Enter
  #   1. dev-channels confirm — "WARNING: Loading development channels" /
  #      "I am using this for local development"            -> Enter (accept)
  #   2. resume dialog, old sessions only — "Resume from summary" /
  #      "Resume full session as-is"         -> Down to option $ResumeChoice + Enter
  # We poll the screen and press the right key for whatever is CURRENTLY up — all
  # via WriteConsoleInput/ReadConsoleOutput, so it works whether the window is
  # visible, minimized or behind others (it is minimized only AFTER this loop; see
  # the end of the script). Recognised prompts only, so we never confirm one with
  # the wrong option. The blind-Enter catch-all after the loop is now ONLY for a
  # screen this handler cannot read: a readable prompt we do not recognise is left
  # for the human, because a blind Enter takes the highlighted default and for
  # the trust prompt that default is "exit". Markers are verbatim from claude.exe.
  # One flag per prompt: each is answered AT MOST ONCE. That is what makes the
  # pending marker below safe to share. "Enter to confirm" is on screen while ANY
  # prompt waits — trust, dev-channels and resume all show it — so on its own it
  # says "something is waiting", not "THIS prompt is waiting". Without the flags,
  # an answered trust prompt still in the buffer would re-match when dev-channels
  # appears with its own "Enter to confirm", and the trust handler's Down would
  # move dev-channels onto "2. Exit" and Enter would take it: claude quits. The
  # flags are the difference between that and one press per prompt.
  $resumeDone = $false; $trustDone = $false; $channelsDone = $false
  $acted = $false; $idle = 0
  $sawUnknownPrompt = $false   # a prompt was WAITING and we did not know it
  for ($t = 0; $t -lt 120; $t++) {   # 120 × 0.5 s = the same 60 s budget as before
    $screen = [ConIn]::ReadScreen([uint32]$proc.Id)
    $hit = $false
    $pending = $false   # reset every frame: never carry last frame's answer over
    if ($screen) {
      $pending = $screen -match 'Enter to confirm'
      if ($ResumeChoice -ge 1 -and -not $resumeDone -and
          ($screen -match 'Resume full session' -or $screen -match 'Resume from summary')) {
        for ($d = 1; $d -lt $ResumeChoice; $d++) {
          [void][ConIn]::SendDown([uint32]$proc.Id); Start-Sleep -Milliseconds 250
        }
        Start-Sleep -Milliseconds 250
        $r = [ConIn]::SendEnter([uint32]$proc.Id)
        try { Write-Output "resume: picked option $ResumeChoice for '$($match.Name)': $r" } catch {}
        $resumeDone = $true
        break   # resume is the last prompt in the sequence
      }
      # Folder trust — shown BEFORE dev-channels for any folder claude has not
      # seen, with "No, exit" highlighted. It was not handled at all, so on a
      # fresh workspace the loop saw nothing it knew, ran its full 60 s, and the
      # blind-Enter fallback then chose the default: claude exited, and cmd /k
      # left an open window with nothing in it. Found by the Windows box
      # 2026-09-24 on a workspace with hasTrustDialogAccepted=false; it was
      # masked only because launches had so far gone to folders already
      # trusted, and /launch now offers every registered one. Down once, then
      # Enter, lands on "Yes, I trust this folder".
      elseif ($pending -and -not $trustDone -and $screen -match 'Yes, I trust this folder') {
        [void][ConIn]::SendDown([uint32]$proc.Id); Start-Sleep -Milliseconds 250
        [void][ConIn]::SendEnter([uint32]$proc.Id)
        try { Write-Output "trust: accepted folder for '$($match.Name)'" } catch {}
        $trustDone = $true
        $hit = $true
      }
      # "Enter to confirm" is on screen only while a prompt is WAITING. Without
      # it this matched the prompt's text after it had been answered — prompt text
      # can stay in the buffer — and pressed Enter again every 0.8 s into the
      # session that had just started. Seen on macOS, where a live agent's screen
      # still held this exact text from its own startup. If the marker ever
      # differs on Windows the prompt goes unhandled and the blind-Enter fallback
      # covers it: slower, never a stray keypress.
      elseif ($pending -and -not $channelsDone -and
              ($screen -match 'Loading development channels' -or $screen -match 'using this for local development')) {
        [void][ConIn]::SendEnter([uint32]$proc.Id)   # accept dev channels (default = confirm)
        try { Write-Output "dev-channels: accepted for '$($match.Name)'" } catch {}
        $channelsDone = $true
        $hit = $true
      }
    }
    # "Unknown" means a waiting prompt that is none of the ones handled above —
    # NOT merely "waiting and not pressed this frame". The looser test was true in
    # nearly every successful launch: an answered prompt stays on screen for at
    # least one more frame, still showing "Enter to confirm", while its branch is
    # already closed by its done flag. Behaviour was right only because the
    # fallback also requires -not $acted; the variable's NAME was wrong, and a
    # name that lies is the one somebody later logs or reuses. Caught by the
    # Windows box on synthetic screens, 2026-09-24.
    #
    # "Known" means recognised AND handled here. Resume counts only while its
    # handling is on: with -ResumeChoice 0 the resume prompt is deliberately left
    # alone, so for the purpose of this flag it is as unknown as any other — and
    # must not fall through to a blind Enter, which would take its highlighted
    # default. (A first draft of this line listed resume unconditionally, and the
    # claim below was false for exactly that case.)
    #
    # With that, the claim holds: where this flag is consulted — nothing was ever
    # acted on — every known-and-handled prompt that was waiting would have been
    # pressed, so none was; the only waiting prompts were unknown ones, and both
    # the old and new definitions set the flag. Only the meaning changed.
    #
    # Parenthesised on purpose: a line break after -or is unambiguous inside
    # parentheses, which is the form the rest of this loop already uses and the
    # Windows box has parsed in both 5.1 and 7.
    $known = ($screen -match 'Yes, I trust this folder' -or
              $screen -match 'Loading development channels' -or
              $screen -match 'using this for local development' -or
              ($ResumeChoice -ge 1 -and
               ($screen -match 'Resume full session' -or $screen -match 'Resume from summary')))
    if ($screen -and $pending -and -not $hit -and -not $known) { $sawUnknownPrompt = $true }
    if ($hit) { $acted = $true; $idle = 0; Start-Sleep -Milliseconds 800; continue }
    # Once we've handled an early prompt and nothing more is recognised for a few
    # frames, the sequence is done (small/new session: no resume dialog) — stop.
    if ($acted) { $idle++; if ($idle -ge 12) { break } }   # 12 × 0.5 s = the old 6 s
    Start-Sleep -Milliseconds 500   # was 1000; the Mac launcher polls at 0.5 s
  }

  # Blind-Enter catch-all — ONLY when the screen handler recognised nothing. If it
  # already dealt with the dev-channels and/or resume prompts, the session is loading
  # or loaded, and a stray Enter could confirm something we don't want (e.g. an
  # auto-compact suggestion). So once we've acted, we keep our hands off.
  #
  # And NEVER when we could read the screen and saw a prompt waiting that we did
  # not recognise. A blind Enter takes whatever is highlighted, and for the folder
  # trust prompt that is "No, exit" — which is exactly how a fresh workspace was
  # killed on 2026-09-24 before trust was handled above. Now that the screen is
  # readable, guessing is the worse option: a window left waiting for one click is
  # recoverable, a window whose claude has exited is not. The blind presses remain
  # for the case they were written for — a screen this handler cannot read at all.
  if ($sawUnknownPrompt -and -not $acted -and -not $resumeDone) {
    try { Write-Output "left '$($match.Name)' waiting on a prompt this script does not recognise; not guessing — answer it in the window" } catch {}
  }
  elseif (-not $acted -and -not $resumeDone) {
    $results = @()
    for ($i = 0; $i -lt $Enter; $i++) {
      $results += [ConIn]::SendEnter([uint32]$proc.Id)
      Start-Sleep -Milliseconds 1200
    }
    # Our own console handle is gone after Free/AttachConsole round-trips; stdout
    # may be dead when launched from a real terminal. Best-effort report only.
    try { Write-Output "sent $Enter Enter(s) to '$($match.Name)': $($results -join ', ')" } catch {}
  } else {
    try { Write-Output "handled startup prompts for '$($match.Name)'; skipping blind Enters" } catch {}
  }
}

# Minimize LAST, after the prompts are handled — never before the first look.
#
# It used to run first, behind a fixed 4 s sleep, so the screen was not read
# until ~7 s in while the dev-channels prompt had long been waiting — measured on
# the Windows box 2026-09-24: first look at 7.0 s, prompt already up. The order
# is free now: the prompt handling above is AttachConsole + WriteConsoleInput +
# ReadConsoleOutput, none of which need the window focused or visible, so the
# reason minimize once had to come first (focus-stealing SendKeys) is gone. And
# by the time that loop finishes the window has long existed, so the sleep that
# waited for it to be created goes too.
#
# Under Windows Terminal this finds nothing to minimize. Not because there is no
# conhost — there is one, as the pseudoconsole provider under cmd.exe — but
# because the VISIBLE window belongs to WindowsTerminal.exe (class
# CASCADIA_HOSTING_WINDOW_CLASS), which is not in the pid set below. We
# deliberately do NOT hunt that window down: one WT window hosts every tab, so
# minimizing it would hide unrelated sessions. The PseudoConsoleWindow stub is
# skipped by class too: minimizing it is what left stray 160x28 strips above the
# taskbar (reported 2026-09-09).
if (-not $NoMinimize) {
  Add-Type -ErrorAction SilentlyContinue @"
using System; using System.Runtime.InteropServices;
public class WinMin {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder b, int m);
}
"@
  $script:mpids = @([int]$proc.Id) + @(Get-CimInstance Win32_Process -Filter "Name='conhost.exe'" |
    Where-Object { $_.ParentProcessId -eq $proc.Id } | ForEach-Object { [int]$_.ProcessId })
  $cb = [WinMin+EnumProc]{ param($h, $l)
    if ([WinMin]::IsWindowVisible($h)) {
      $wp = 0; [void][WinMin]::GetWindowThreadProcessId($h, [ref]$wp)
      if ($script:mpids -contains [int]$wp) {
        $cls = New-Object System.Text.StringBuilder 256
        [void][WinMin]::GetClassName($h, $cls, $cls.Capacity)
        # Minimizing the pseudo-console stub is what produced the stray white strips.
        if ($cls.ToString() -ne 'PseudoConsoleWindow') { [void][WinMin]::ShowWindow($h, 6); $script:minimizedCount++ }   # 6 = SW_MINIMIZE
      }
    }
    return $true }
  $script:minimizedCount = 0
  [void][WinMin]::EnumWindows($cb, [IntPtr]::Zero)
  # Say what happened, not what was attempted. The unconditional line printed
  # "minimized" on a Windows Terminal host where nothing was minimized at all —
  # measured 2026-09-24, the window stayed full size at 304,312 — which reads as
  # success and sends whoever debugs this looking in the wrong place.
  if ($script:minimizedCount -gt 0) {
    Write-Output "minimized '$($match.Name)' window"
  } else {
    Write-Output "left '$($match.Name)' as is: no window of its own to minimize (Windows Terminal owns it, and minimizing that would hide every tab)"
  }
}
