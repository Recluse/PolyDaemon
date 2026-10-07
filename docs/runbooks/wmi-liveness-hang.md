# Runbook — WMI liveness hang (windows flap offline / mis-route)

**Incident:** 2026-05-27. **Fix shipped:** 2026-05-27 (plugin `src/registry.ts`,
the terminal launcher, `~/.claude.json` MCP env).

## Symptoms (what the user sees)

- In the bot, **all windows drop offline except one** (whichever still answers a
  direct ping), seemingly out of nowhere ("отвалились все окна кроме кастомс").
- A message sent **to one window's topic lands in the wrong window** (routing
  collapses onto the single still-"online" window).
- A **freshly launched** VSCode window **registers under the wrong name** (e.g.
  a `…\infra\Minecraft` window comes up as `infra`) and/or the **integrated
  PowerShell terminal hangs/crashes** during startup.
- Router-bot log shows, repeatedly:
  `instance-refresh … skipped: maximum number of running instances reached (1)`
  and eventually a `MemoryError`.

## Root cause

The window-liveness machinery shells out to
`powershell Get-CimInstance Win32_Process …` (WMI). On a loaded box the WMI
provider host (`WmiPrvSE`) gets recycled/throttled and **every WMI query hangs
for minutes**, failing with `HRESULT 0x80041033` (`WBEM_E_SHUTTING_DOWN`).

Measured during the incident on this box:

| call | duration |
|------|----------|
| `Get-CimInstance Win32_Process -Filter ProcessId=…` | **358 000 ms** then `0x80041033` |
| `Get-Process -Id …` (native, no WMI) | **~0.5 s** |

The cascade:

1. The **channel plugin** (`src/registry.ts`) called WMI at *every window start*
   — `_procStartTime` (own PID, for the `started_at` reuse token) and
   `_parentCommandLine` (to detect `--dangerously-load-development-channels`).
   With WMI wedged, a new window's plugin hangs for minutes → it registers late
   and wrong, and the spawned `powershell` children thrash the terminal.
2. The **router bot's** `instance-refresh` job (`broadcast_changes_job`, every
   `bot.instance_poll_interval` s) overruns its interval and piles up, so the
   bot can no longer tell which windows are live → they flap offline; only the
   one that still answers `/status` survives → all routing collapses onto it.
3. Under the underlying **machine memory pressure** that wedged WMI in the first
   place, the bot eventually throws `MemoryError` (seen in `bot/topics.py`
   `_write_bindings`).

> Note: the **Python bot side** (`tg-bot/bridge/registry.py`) had *already* moved
> off WMI to native `OpenProcess`/`GetProcessTimes` (ctypes). Only the
> TypeScript plugin still used WMI — that was the gap this fix closes.

## The fix (2026-05-27)

All in the **plugin** (`channel-plugin/src/registry.ts`) plus launch env:

1. **`_procStartTime` → `Get-Process` instead of `Get-CimInstance`.** Same token
   value (whole seconds of the kernel creation time since 1601 UTC via
   `StartTime.ToFileTimeUtc() / 1e7`), but **no WMI**. Verified the token matches
   the bot's ctypes `GetProcessTimes` exactly (both `13424344069` for the same
   PID, equal to the on-disk `started_at`), so PID-reuse detection still works
   and no live window gets falsely reaped.
2. **Hard, killing timeouts on every `spawnSync`:** `timeout` (5 s start-time,
   4 s parent-cmdline, 3 s tasklist) + `killSignal: 'SIGKILL'` + `windowsHide:
   true`. A slow lookup now degrades to `null` (caller falls back to plain
   PID-liveness) instead of blocking startup for minutes, and no console windows
   flash.
3. **Honour the `TG_BRIDGE_FORCE_CHANNELS=1` bypass *before* paying the WMI
   cost.** `PARENT_CMD` used to call `_parentCommandLine()` (the one unavoidable
   WMI call — a process command line needs WMI on Windows PowerShell 5.1)
   *unconditionally at import*, so the bypass env didn't actually save you. Now
   `PARENT_CMD = TG_BRIDGE_FORCE_CHANNELS==='1' ? '' : _parentCommandLine()`.
4. **Set `TG_BRIDGE_FORCE_CHANNELS=1` in both launch paths** so the WMI
   parent-probe never runs in practice:
   - the terminal launcher (then a personal `start-claude.ps1`; today every
     launcher, `tg-claude.cmd` and `clients/tg-claude.sh`, sets it).
   - `~/.claude.json` → `mcpServers.tg-bridge.env` (every VSCode-launched window).
   Safe here because *all* windows are started with
   `--dangerously-load-development-channels` (terminal launcher + the VS Code
   extension's `autoConfirmDevChannels`).

Net result: with the env set, the plugin makes **zero** WMI calls; the only
remaining `powershell` spawn is a single ~0.5 s native `Get-Process` at
registration, hard-bounded so even that can't hang startup.

## Recovery (if it recurs before/independent of the fix)

WMI being wedged is an **OS/machine-state** problem (usually memory pressure);
the code fix stops it from *cascading*, it doesn't make WMI healthy. To clear a
live wedge:

1. **Reboot** — cleanest WMI reset (and relieves the memory pressure that caused
   it). Preferred.
2. Without a reboot: `net stop Winmgmt /y && net start Winmgmt` (has dependents
   but recovers), then **restart the router bot** (bots-tray → tg-bridge) to
   clear the `MemoryError`/job backlog, then **reload each Claude window**.

## Diagnose / verify

```powershell
# Is WMI wedged? (healthy ≈ tens of ms; wedged = many seconds / 0x80041033)
Measure-Command { Get-CimInstance Win32_Process -Filter "ProcessId=$PID" }

# The fix's path — should always be sub-second even when WMI is wedged:
Get-Process -Id <pid> | % { [long][Math]::Floor($_.StartTime.ToFileTimeUtc()/1e7) }
```

```bash
# Router-bot health — these lines mean the liveness refresh is overrunning:
grep -E "maximum number of running instances|MemoryError" logs/tray-tgbridge.log
```

Registry/state lives in `~/.tg-copilot-bridge/` (`instances/*.json`,
`topic-bindings.json`, `bot.db`). A live instance file carries `pid` +
`started_at` (the start-time token both sides compare).
