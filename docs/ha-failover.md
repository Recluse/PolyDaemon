# Two bot hosts, one bot: active and standby

A single bot host is a single point of failure. This page describes how to keep
a second host ready so an operator can move the bot to it quickly. It is **not
automatic high availability**. Nothing here promotes the standby because the
active host went silent. A silent peer and a network partition look the same
from the standby. A promotion based on silence can leave two routers polling
through two Bot API sessions for the same token.

- **primary**: the preferred host, normally the active one;
- **reserve**: a standby that is staged and replicated. It starts only when an
  operator promotes it after fencing the old active.

The authoritative procedure for moving the bot between hosts is
[runbooks/router-cutover.md](runbooks/router-cutover.md). This page explains
the pair's tooling and must be read together with that runbook. If the two
disagree, the runbook wins. The mechanics of a single bot host are in
[multi-machine.md](multi-machine.md).

```text
 Telegram ◄──► active (primary)          standby (reserve)
                 │ router :8090             │ router: stopped, permit denied
                 │ bot-api :8081            │ bot-api: no session for this bot
                 ▼                          ▼
          failover controller        failover controller
          observe + log              observe, self-stop if both serve
```

## What keeps two routers from polling at once

The goal is that exactly one router and one Bot API session exist for the
token. Each layer below has known limits:

1. **Activation permit** (`tg-bot/bot/activation.py`). A host that declares a
   role (`POLYDAEMON_NODE_ROLE=primary|reserve`) refuses to start unless
   `POLYDAEMON_NODE_ID` and `POLYDAEMON_ACTIVATION_FILE` are set and the
   permit file contains that node id. The running router re-reads the permit
   before it replays pending receipts and every 15 s while polling. When the
   permit stops granting this node, the router stops polling. Only an operator
   grants the permit, through `promote` below. The permit is a local file. It
   is **not** a distributed lease and does not fence a host you cannot reach.
   A host that sets none of the three variables runs as a standalone install
   without a permit. Always set the role on both hosts of a pair.
2. **Controller** (`ci/polyd_failover.py`). It never starts a router and never
   grants a permit on its own. Its only automatic action is in the safe
   direction: a reserve whose router is up while the primary also reports a
   serving router stops its own router and writes the deny value.
3. **No reliable 409 backstop.** The `getUpdates` 409 Conflict is returned
   by the Bot API server that receives two concurrent pollers. Each host here
   runs its own local Bot API server with its own session, so two routers on
   two servers never meet on one server's `getUpdates`, and nothing guarantees
   a 409. How updates are split between two live sessions has not been tested
   and must not be relied on. `tg-bot/bot/error.py` still stops a `reserve`
   router on a 409, but treat that as a diagnostic. It is not an arbiter.
   Exclusion has to come from fencing the old host.

## Running each host's router

The compose service on **both** hosts must declare the HA role. Otherwise it
runs as a standalone install and polls without a permit. The single-host
example in [multi-machine.md](multi-machine.md) is standalone: it has none of
these variables and uses `restart: unless-stopped`. Do not reuse it for a pair.

```yaml
services:
  tg-bridge-bot:
    image: tg-bridge-bot:latest
    container_name: tg-bridge-bot
    profiles: ["polydaemon-standby"]   # started only by an explicit command/promote
    restart: "no"                      # no restart policy may reactivate a fenced host
    ports:
      - "127.0.0.1:8090:8090"          # local_health_url of the controller
      - "10.42.101.2:8090:8090"        # this host's mesh address, for clients/forwards
    environment:
      POLYDAEMON_NODE_ROLE: reserve    # "primary" on the other host
      POLYDAEMON_NODE_ID: router-b       # this host's node_id
      POLYDAEMON_ACTIVATION_FILE: /permit/polydaemon-active-node
    volumes:
      - tg-bridge-state:/data
      - ./tg-bot/config.yaml:/app/config.yaml:ro
      - /home/polyd/bot-api/permit:/permit:ro
volumes:
  tg-bridge-state: {}
```

The registry must be reachable on the host for the controller's
`local_health_url` (`http://127.0.0.1:8090/`) and for client loopback
forwards. Inside the container set `bot.registry_bind_host: "0.0.0.0"`, and
set `registry_verify_source_ip: false`, because Docker's port publishing
rewrites the source address. The enroll token and `mesh_subnet` still gate
registration. Without a published port the controller sees the router as
down, and `promote`'s "local router already serving" check passes even
while a router runs.

Mount the permit's **directory**, not the file. The controller replaces the
permit by an atomic rename, and a single-file bind mount keeps showing the
old inode. `permit_path` in the controller config must be the real file
inside that directory (`~/bot-api/permit/polydaemon-active-node`). The
controller refuses a `permit_path` that is a symlink, because a rename would
replace the link and leave the target at the old grant. The supplied CI job
only *reads* `~/bot-api/polydaemon-active-node`. Make that path the symlink,
pointing at `permit/polydaemon-active-node`:

```sh
mkdir -p ~/bot-api/permit
ln -sfn permit/polydaemon-active-node ~/bot-api/polydaemon-active-node
```

## The failover controller

`ci/polyd_failover.py` runs as a systemd service on each host. It exposes a
tiny control endpoint (`GET /state`, `POST /demote`, shared token header) and
ticks every `probe_interval_s`:

| role | local router | peer | action |
|---|---|---|---|
| primary | up | any | nothing (never rewrites the permit) |
| primary | down | any | log `needs-operator:primary-router-down*` |
| reserve | up | serving | stop own router, write deny value (self-heal) |
| reserve | up | silent | keep serving |
| reserve | down | silent for `promote_after_s` | log `needs-operator:peer-unreachable` |
| reserve | down | reachable | nothing |

`promote_after_s` now only controls when the "needs operator" alert appears.
It never triggers a start.

Config (JSON, one per host; see `ci/deploy/failover/*.example.json`):

```json
{
  "node_id": "router-a",
  "peer_node_id": "router-b",
  "role": "primary",
  "control_listen": "192.0.2.2:8099",
  "control_token": "<32+ chars, same on both hosts>",
  "peers": ["http://10.42.101.2:8099"],
  "local_health_url": "http://127.0.0.1:8090/",
  "permit_path": "/home/polyd/bot-api/permit/polydaemon-active-node",
  "deny_value": "maintenance",
  "start_cmd": ["docker", "compose", "-f", "/home/polyd/bot-api/tg-bridge.yml",
                "-p", "tg-bridge", "--profile", "polydaemon-standby", "up", "-d"],
  "stop_cmd": ["docker", "compose", "-f", "/home/polyd/bot-api/tg-bridge.yml",
               "-p", "tg-bridge", "stop"],
  "promote_after_s": 90,
  "probe_interval_s": 15,
  "fencing_evidence_max_age_s": 900,
  "state_path": "/home/polyd/bot-api/failover-state.json"
}
```

The reserve's config mirrors it with `"role": "reserve"`, its own `node_id`
and `control_listen`, and the primary as its peer (`"peer_node_id": "router-a"`).

`pre_start_cmd` is optional. It runs only inside an operator `promote`, with
the evidence path in `POLYD_FENCING_EVIDENCE`, and a failure blocks the
start. It is meant for read-only readiness checks. The controller refuses a
`pre_start_cmd` that restores state (`polyd_state_sync.py`,
`router_state.py` or `router_online_backup.py` with `restore`). State is
restored and verified in step 5 below, before readiness, and a second
restore during promote would overwrite that verified checkpoint with an
older online copy.

## Promoting a node (operator only)

Follow [runbooks/router-cutover.md](runbooks/router-cutover.md) in its order.
The controller does none of these steps for you:

1. **Drain callers**: block new client and recovery-proxy requests to the
   old router and account for in-flight ones.
2. **Single-active exclusion**: stop the old router gracefully and write
   the deny value into its permit. Disable every activation path on the old
   host: restart policy, systemd, compose profile, CI and manual launchers.
   If the old host cannot be reached, it is **not** fenced. Isolate or power
   it off by a means you can verify, and make sure it cannot come back on
   boot. If you cannot do this, stop here.
3. **Durable state checkpoint**: while the old host is reachable, take a
   quiesced `ci/router_state.py snapshot --writers-stopped` and verify it at
   the destination. An online per-file copy from the replication timer is
   recovery material only (see below).
4. **Bot API protocol**: delete the webhook without dropping updates, call
   `close` (or `logOut` when the session will not be moved) on the old
   server, then move only this bot's closed session directory
   (`ci/botapi_session.py`). A failed `close` blocks the cutover. Do not start
   a second session to work around it.
5. **Volume restore**: run `ci/router_state.py verify` on the transferred
   checkpoint at the destination, then copy exactly the files named in its
   manifest into a new private state directory. `polyd_state_sync.py
   restore` is not the tool for this step: it accepts only
   `router_online_backup.py` captures, and a `router_state.py` manifest
   fails its verifier. Use it only when no quiesced checkpoint exists (the
   old host is gone) and after reconciling `pending` rows, as described
   below.
6. **Readiness**: client transport, attachment paths, and no unreconciled
   `processing`/`uncertain` journal rows.
7. **Promotion**: write the evidence file and run `promote`:

```sh
cat > /home/polyd/bot-api/fencing-evidence.json <<JSON
{ "fenced_node": "router-a",
  "method": "router stopped exit 0, restart disabled, CI permit denied, bot API close() ok, session moved",
  "verified_by": "Recluse",
  "verified_at": $(date +%s) }
JSON
python3 ~/bot-api/polyd_failover.py --config ~/bot-api/failover.json \
    promote --operator-decision --fencing-evidence /home/polyd/bot-api/fencing-evidence.json
```

`fenced_node` must equal the config's `peer_node_id` (the node being
replaced); an absent `peer_node_id` refuses every promotion. `verified_at` is
finite Unix time no older than `fencing_evidence_max_age_s`. `promote` refuses in these cases: the decision
flag or the evidence is missing; the evidence is stale, incomplete or names
this node; a reachable peer still reports a serving router; or a local router
is already up. The evidence is your attestation. The controller **cannot**
verify that the old node is really fenced.

Failback is another cutover in the same order. A primary does not reclaim
the bot by itself.

## State replication

`ci/polyd_state_sync.py push` runs from a timer on the active host and ships
verified per-file snapshots (`ci/router_online_backup.py` capture) to the
standby over ssh:

```sh
# on the active host, e.g. every 5 minutes
python3 ci/polyd_state_sync.py push /home/polyd/.tg-copilot-bridge \
    --host reserve-host --remote-root /home/polyd/bot-api/snapshots --keep 12
```

Limits to know before restoring one:

- The capture is **per-file**, not an atomic checkpoint. Its manifest
  declares `automatic_restore_allowed=false`. A restore can pair a newer
  `bot.db` with an older `updates.db`.
- `restore` picks the **newest** snapshot and does not bound its age. If
  pushes failed, the newest snapshot can be hours or days old. Check the
  directory timestamp first.
- **The update journal does not prevent replay of a stale snapshot.** On
  restart, `UpdateJournal.recover` re-queues every `pending` receipt and
  handles it again. Only receipts that were `processing` (interrupted
  handlers) become `uncertain` and are held for manual reconciliation. A
  snapshot taken before the old node finished some updates shows them as
  `pending`, so the new node runs them again (duplicate injections, repeated
  callbacks). Prefer a quiesced `router_state.py` snapshot. Otherwise inspect
  and reconcile `pending` rows against the old node's journal before
  promoting.
- The Bot API **session** is not part of the snapshot. Move the closed
  session as described in the runbook. Starting a fresh session on the new
  host while the old one may still be alive is exactly the two-session case
  the runbook forbids.

## Client configuration per OS

Each machine gets an ordered endpoint list in
`~/.tg-bridge-channel/transport.json` (primary first). The plugin moves on
when a request fails: a transport failure marks the endpoint down for a
minute, the next request goes to the next endpoint, and an expired mark lets
the primary be preferred again. This follows whichever router is serving. It
does not decide which router serves.

The plugin's validator (`channel-plugin/src/transport-config.ts`) accepts
only `http://127.0.0.1:<port>` URLs. Remote bot hosts are therefore reached
through local loopback forwards (an SSH `-L` tunnel or an equivalent local
proxy), one distinct local port per remote service:

```json
{
  "version": 2,
  "endpoints": [
    { "bot_url": "http://127.0.0.1:18090", "api_root": "http://127.0.0.1:18081",
      "botapi_ssh": "router-a", "botapi_container": "telegram-bot-api" },
    { "bot_url": "http://127.0.0.1:28090", "api_root": "http://127.0.0.1:28081",
      "botapi_ssh": "router-b", "botapi_container": "polyd-bot-api" }
  ]
}
```

Here `127.0.0.1:18090/18081` forward to the primary's `:8090/:8081` and
`127.0.0.1:28090/28081` to the reserve's. Mesh addresses such as
`http://192.0.2.2:8090` are rejected, and the plugin then refuses to start
rather than falling back to an old route.

`botapi_ssh`/`botapi_container` travel with the endpoint. They tell
`download_attachment` where the local Bot API keeps the file bytes on that
host, so attachment downloads follow the switchover too. Keep them empty
(`""`, `"telegram-bot-api"`) when the Bot API runs on the same machine as the
plugin and is reached with `docker cp` directly.

### macOS

```sh
mkdir -p ~/.tg-bridge-channel
cat > ~/.tg-bridge-channel/transport.json <<'JSON'
{ "version": 2, "endpoints": [ /* primary, then reserve — see above */ ] }
JSON
chmod 600 ~/.tg-bridge-channel/transport.json
```

Restart the windows (or at least their plugins) to pick it up. The launch agent
that starts windows (`launchctl kickstart -k gui/$(id -u)/polydaemon.launch-agent`)
does not need to know about the pair.

### Windows

Same file, same shape. PowerShell (elevated not required):

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.tg-bridge-channel" | Out-Null
@'
{ "version": 2, "endpoints": [ /* primary, then reserve */ ] }
'@ | Set-Content "$env:USERPROFILE\.tg-bridge-channel\transport.json" -Encoding Ascii
```

Restart the windows afterwards. The launch agent is a scheduled task; it reads
the plugin config at plugin start, not at agent start.

### Linux

Identical to macOS: write `~/.tg-bridge-channel/transport.json`, restart the
windows (in tmux, that means restarting the pane's plugin process).

### Verifying on any OS

```sh
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:18090/heartbeat -d '{}'
# 401 = the router is answering through the forward (it wants a token); 000 = unreachable
```

With the plugin running, `~/.tg-bridge-channel/debug.log` should show heartbeats
succeeding. After a switchover it logs
`PolyDaemon: bot endpoint failover -> http://…`.

## Rehearsing

Rehearse the whole runbook, not the controller alone. Watch both controllers'
journals (`journalctl --user -u polyd-failover -f`). Stopping the active router
should produce `needs-operator:*` lines and **no** start on either host. A
`promote` without fresh evidence must be refused. A `promote` after the
runbook steps should log `operator promotion on <id>` and start one router.

## What is not covered

- **Automatic failover.** It needs a fencing mechanism and state replication
  that the pair does not have: a distributed lease or witness, verified
  Bot API session handover, and an atomic state checkpoint.
- **Split brain / distributed fencing.** Nothing here is distributed
  fencing. The permit, `router.lock`, the controller's host lock and the CI
  check are all local to one host. With no witness, a partition leaves the
  controllers unable to tell a dead peer from a cut link, so they only
  alert. If an operator promotes without really fencing the old node, two
  routers and two Bot API sessions can run at once, and nothing in this
  tooling will stop that.
- **Demote during promote.** A `POST /demote` that arrives while a
  `promote` runs waits for the controller's host lock. The HTTP caller may
  time out first, and the stop then happens after the promotion finishes.
- **Undeclared HA hosts.** A host with none of the three `POLYDAEMON_*`
  activation variables is treated as standalone and polls without a permit.
  That includes any host built from the multi-machine.md compose example.
  Check every bot host's compose file. The code cannot detect this.
- **CI.** `.gitlab-ci.yml` deploys on `main` wherever
  `polydaemon-active-node` equals `polydaemon-node-id`. It checks before the
  build and again right before `compose up`. Deny the permit on the old host
  as part of fencing, or a later pipeline recreates its router.
- **Cross-host DNS or VIP failover** is not used. Clients hold the ordered
  endpoint list instead.
