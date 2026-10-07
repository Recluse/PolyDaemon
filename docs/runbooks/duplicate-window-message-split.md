# Runbook — duplicate window / inbound messages split (only some arrive)

**Incident:** 2026-06-01. **Fix shipped:** 2026-06-01 (bot `bridge/registry.py`).
Decision recorded in [ADR-0003](../adr/adr-0003-stable-instance-dedup.md).

## Symptoms (what the user sees)

- Messages sent to **one window's topic only arrive sometimes** — e.g. "из трёх
  сообщений в infra дошло одно". The plugin logs `notification sent OK` for all of
  them (they went to the *other* window, they are not lost).
- A window dies on its own with VS Code
  `The window terminated unexpectedly (reason: 'oom', code: '-536870904')`, or its
  integrated terminals die with `powershell.exe … exit code -1073741523`
  (= `0xC000012D`, `STATUS_COMMITMENT_LIMIT`).
- The `instances` table briefly holds **two live rows for the same workspace**.

## Root cause

Two layers, often together:

1. **Duplicate live windows on one folder.** The same path is open in two Claude
   hosts at once (e.g. VS Code extension + npm-CLI `claude` on
   the same workspace path on each). Each host's plugin registers its own row
   (`channel-plugin/src/registry.ts`, random per-process `REGISTRY_ID`), so the
   `instances` table has two rows with the **same `workspace_name` and `cwd`**.

   Inbound routing (`bot/messages.py` `_resolve_topic_target`) picks the instance
   from the deduplicated runtime list on every message. The old dedup in
   `bridge/registry.py` kept the **freshest-heartbeat** row; two live windows
   heartbeat every ~15 s and leapfrog, so the winner **flipped every refresh** and
   a topic's inbound split across both windows. Same-`cwd` duplicates were dedup'd
   **silently** (no warning), so it was invisible in logs.

2. **System commit exhaustion crashes windows (the trigger for #1).** When the
   machine runs out of commit (Windows commit charge ≥ limit), new allocations
   fail with `STATUS_COMMITMENT_LIMIT` — VS Code renderers (`reason:'oom'`) and
   terminal `powershell.exe` die. A **hard** crash skips the plugin's
   `unregisterInstance()`, so the dead window's row lingers until the bot reaps it
   (~45 s, dead-PID / stale-heartbeat). Reopen the folder in that window meanwhile
   → a second live row → the flip-flop of #1.

   Commit OOM here was a too-small pagefile (limit ~24 GB vs ~23 GB committed),
   not RAM-app bloat — fix it via the recovery below. Diagnose memory **WMI-free**
   (the WMI perf classes hang under exactly this pressure — see
   [wmi-liveness-hang.md](wmi-liveness-hang.md)): `GlobalMemoryStatusEx` via
   P/Invoke for the commit limit, `Get-Process | sort PrivateMemorySize64` for
   per-process commit.

## The fix (2026-06-01) — bot only, plugin unchanged

In `tg-bot/bridge/registry.py` `load_runtime_instances()`:

1. **Stable winner on key collision.** The duplicate is resolved by
   `max(int(started_at), -port)` instead of freshest heartbeat. `started_at` (the
   per-process creation token) is fixed for a process's life → the winner does
   **not** change between refreshes, so inbound stops ping-ponging. A reload's new
   process still wins (later `started_at`); lower port breaks ties.
2. **Loud warning on same-`cwd` duplicates:**
   `workspace 'X' has two live windows (ports A, B) — routing to the later-started
   one; close the extra window`. The different-`cwd` warning ("rename one") stays.

> The **plugin** (`channel-plugin/`) was investigated but **not modified**. One
> window still = one row; the duplicate comes from genuinely opening two hosts on
> one folder. A possible future hardening (not done): the plugin self-detects a
> live same-`cwd` peer at startup and warns/refuses. See ADR-0003 alternatives.

Verified: `python -m py_compile bridge/registry.py` OK; unit test with two
leapfrogging-heartbeat rows → winner unchanged on both refreshes. **Needs a router-
bot restart to take effect.**

## Recovery (operational, no code)

1. **Collapse to one window per folder.** Decide which to keep; close the extra
   Claude host. If it crashed hard and only the stale row remains, it self-reaps in
   ~45 s, or force it:
   ```python
   import sqlite3, pathlib
   c = sqlite3.connect(pathlib.Path.home() / '.tg-copilot-bridge' / 'bot.db')
   for row in c.execute("select id,port,pid,heartbeat_at from instances "
                        "where workspace_name='infra'"):
       print(row)
   c.execute("delete from instances where id='<stale-id>'"); c.commit()
   ```
2. **Relieve commit** if windows are OOM-crashing: `wsl --shutdown` (frees the WSL
   VM commit), close spare Firefox/Chromium, or **reboot** (cleanest — also lets a
   resized/auto pagefile take effect and clears the duplicate state).
3. **Restart the router bot** so it loads the dedup fix and re-reads `instances`.

## Diagnose / verify

```python
# Duplicate? >1 fresh row for one workspace = the bug.
import sqlite3, time, pathlib
c = sqlite3.connect(pathlib.Path.home() / '.tg-copilot-bridge' / 'bot.db')
now = time.time()
for wsname, port, pid, started, hb in c.execute(
        "select workspace_name,port,pid,started_at,heartbeat_at from instances"):
    print(wsname, port, pid, 'age_s=', round(now - hb, 1))
```

```powershell
# Commit limit/usage WMI-free (the real cause of the window OOM crashes).
# 0xC000012D STATUS_COMMITMENT_LIMIT = out of commit.
Add-Type @'
using System;using System.Runtime.InteropServices;
public class Mem{[StructLayout(LayoutKind.Sequential)]public struct M{
 public uint dwLength,dwMemoryLoad;public ulong a,b,c,d,e,f,g;}
 [DllImport("kernel32.dll")][return:MarshalAs(UnmanagedType.Bool)]
 public static extern bool GlobalMemoryStatusEx(ref M s);}
'@
$m=New-Object Mem+M;$m.dwLength=[uint32][Runtime.InteropServices.Marshal]::SizeOf($m)
[void][Mem]::GlobalMemoryStatusEx([ref]$m)
'commit used {0:N1}GB / limit {1:N1}GB' -f (($m.c-$m.d)/1GB),($m.c/1GB)
```

```bash
# Router-bot log — the new warning makes a live duplicate self-announce:
grep -E "has two live windows|used by two cwds" logs/tray-tgbridge.log
```

State lives in `~/.tg-copilot-bridge/` (`bot.db` → `instances`, `window_topics`,
`message_routes`). The old per-window `instances/*.json` file registry is
abandoned (migrated into `bot.db`) and was deleted 2026-06-01.
