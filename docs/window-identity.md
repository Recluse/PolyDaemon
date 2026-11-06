# Window identity and its threat boundaries

The bot never addresses a window by its name. Names repeat across folders and
hosts, and every path that resolved a name used to reach whichever window held
it.

## Identity

| Term | What it is | Where it comes from |
|---|---|---|
| workspace | host + folder (cwd) + agent | the plugin's registry row; topics are bound to cwd(#agent) |
| incarnation | one plugin process | its registry row id (random per process; remote ids are prefixed `<ip>#` when the source IP is verified) |
| window | a launched agent window | `TG_WINDOW_UID`, minted by the launcher on every launch (kept only on an explicit relaunch with `TG_WINDOW_UID_KEEP=1`) |
| name / label | display only | `workspace_name`; labels add host and folder (and a row id) when names collide |

Keys:
- `w:<uid>@<hash(uid, host, cwd, agent)>` for a window that exactly one live row claims;
- `r:<row id>` for anything else, i.e. no uid, or a uid claimed by several rows (flagged ⚠️).

A stored key (active window, default window) can only resolve to a window in the same place.

## Resolution rules (all fail closed)

**Topic**
- Every live window of the topic's bindings is considered.
- Exactly one: it is the target.
- Several (two windows in one folder, the same path on two hosts): refused with a count.
- None: "not running".
- Windows without a cwd are never topic-bound.

**Reply or reaction to a recorded message**
- The same incarnation, if it is still live.
- Otherwise the same window after a reconnect, but only if exactly one live row has the recorded uid AND the recorded host, folder and agent.
- A route without identity (older code, name only) is refused. So is a reply to a bot message with no route.

**Decisions** (ask, approve, plan)
- Only the exact process that issued the card.
- Never another window, never by topic guess.
- A free-text answer to an ask is bound to the asking process. If that process is gone, the answer is not sent anywhere.

**Confirmations** (`/exit`, `/restart`, `/effort`, `/model`, `/restart all|stale`)
- The target rows are recorded when the buttons are shown, keyed by (chat id, message id).
- A record is consumed on the first tap and expires after 10 minutes.
- Records are kept in memory only, so a bot restart invalidates every button.

**Addressing by name** (`@name`, inter-window `to`, the default window)
- Selected only if exactly one live window matches.

**Sends** (messages, `/inject`, decisions)
- Pinned to the chosen row's endpoint and carry `X-PolyDaemon-Row`.
- A current plugin refuses (409) a request meant for another row, e.g. a new window on a reused port.

## Threat boundaries

What the checks do and do not establish. Nothing here is "protected" beyond these lines.

**Trusted, without per-window credentials**
- The bot, the plugins and agentd share bearer tokens: `TG_BRIDGE_AUTH_TOKEN` (also the registry enroll token) and agentd's token.
- Any holder of these can:
  - register rows and claim any name or uid;
  - with `registry_verify_source_ip: false` (NAT setups), name another peer's row id in `/route`;
  - read and move tasks of any window name;
  - make the first Codex thread binding for a window id it knows.
- Ending this needs per-window credentials. That is not part of this change.

**What a uid proves**
- Nothing by itself; it is copied with an environment.
- Combined with an unchanged host, folder and agent, and uniqueness among live rows, it lets a reply follow a reconnected window.
- It never moves a decision or a confirmation to another process.

**Row pinning (`X-PolyDaemon-Row`)**
- Enforced only by plugins that implement it.
- An older plugin ignores the header. This applies:
  - while plugins are upgraded before the router;
  - after a rollback of plugins;
  - to any older plugin still running.

  In all these cases a send pinned to a gone row can still be accepted by a different older process on that port. **Rollback compatibility of the database does not make a downgrade safe.**

**Routes**
- A route is recorded once per (chat id, message id) and is never reassigned to another row (atomic check-and-write).
- An enrolled peer can still record routes for messages that have none yet, under its own row.

**Tasks**
- Inter-window tasks are keyed by window name, and the `window` field is the client's claim.
- Same-named windows share a task list.

**Mixed versions**
- An old router accepts a new plugin's requests but drops the identity fields.
- Routes recorded before the router upgrade, and all routes of old plugins, are refused after the upgrade, with a hint to write in the topic or pick a window.
- A new plugin's "Reply here" button fails under an old router.
