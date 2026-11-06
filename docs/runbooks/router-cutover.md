# Single-active router cutover

This runbook is a controlled migration, not automatic high availability.
There is no distributed lease or witness. Loss of reachability must never
promote the standby. Two Bot API sessions for the same token are unsafe even
if only one application appears to be polling.

## Fresh acceptance for a resumed migration

Receipts from an abandoned migration are not reusable after client rollback,
process replacement, or a change of transport. In particular, an old
`old_bridge_processes_gone` flag does not establish the current client's API
destination. A staged image/configuration containing SSH dial mappings is not
the configuration for a later direct-WireGuard migration.

Before stopping the active router, record a new acceptance set for the exact
deployment attempt:

- Current active host, router process/container identity, Bot API session
  location, authoritative state directory, and all boot/CI activation paths.
- Bidirectional network probes with observed source addresses and return
  routes, including preservation of the existing client path. A handshake
  alone is insufficient. Separate proxy reachability from backend independence.
- Every live client process and its effective registry, Bot API and attachment
  destinations. Configuration files alone are insufficient; include residual
  MCP connections retained by an app-server after reload.
- The reviewed image/configuration hashes, with obsolete transport mappings
  removed, and a verified standby that has not opened the real bot session.
- An explicit drain/fencing procedure for every old API caller and recovery
  proxy. Terminating a proxy listener is not proof that its in-flight requests
  completed. Block new requests and account for outstanding ones before close.
- A checkpointed recovery procedure for each partial failure, preserving any
  writes accepted by the new active instead of restoring an older snapshot.

Do not run an earlier one-shot cutover script by deleting its hold file.
Review its endpoints, process guards, receipts and failure recovery against
this new acceptance set first. Until then the existing active remains active.

## Preparation

- Verify independent routes in both directions for every client, registry,
  Bot API and attachment transport. SSH from one laptop is not sufficient.
- Stage the same tested router version on both hosts. Keep the new service
  stopped and without its activation permit. Do not call the new Bot API with
  the real bot token yet.
- Set both `POLYDAEMON_NODE_ID` (different on each host) and
  `POLYDAEMON_ACTIVATION_FILE` (absolute path outside the image). The file must
  contain exactly the permitted node ID. Missing/mismatched files refuse
  startup before network access. This is an operator-controlled permit, NOT
  a distributed fencing mechanism. Standalone installations may omit both.
- The router also holds an OS lock on `router.lock` in its state directory.
  The lock prevents two processes sharing that directory, not two machines.
- Record all activation paths: restart policies, systemd, compose profiles,
  CI deployment and manual launchers. Disable the old host's activation paths
  before granting the new host permission. `docker stop` alone is insufficient.
- The supplied GitLab job requires nonempty, byte-identical host files
  `~/bot-api/polydaemon-node-id` and `~/bot-api/polydaemon-active-node` before
  building or starting anything. Configure them explicitly during deployment.
  This protects new pipelines only: also park the old compose service behind
  a standby profile and remove its restart policy so an older pipeline cannot
  reactivate it. Do not rely solely on a checked-in CI change.
- Update/reconnect client MCP descriptors in a planned maintenance interval.
  Preserve sessions, topic identities, credentials and unrelated MCP servers.
  Never repoint a shared infrastructure SSH alias to make file downloads work.
  A receipt-only listener returning 503 is not a usable replacement registry.
  Repointing clients to it disconnects live windows even while the old router
  remains healthy. Do not treat an acknowledged MCP reload as proof that old
  client processes or their outstanding requests have drained.

Before closing the old Bot API session, a temporary loopback proxy to the
same old active router/API can restore messaging after a failed client
transition. Keep the new Bot API stopped, preserve registry authentication,
restrict API paths to this bot, and suppress token-bearing request logs.
This is degraded recovery, not independent operation or HA acceptance.
Attachment SSH/container routing must still match the authoritative files;
a successful text reply does not prove file downloads. Fence all recovery
proxies before closing/moving the old session, and invalidate any earlier
client-readiness receipts before retrying the migration.

Temporary SSH transports can use `bot.transport_routes`, a mapping from exact
logical `host:port` strings to local loopback ports. Registry identities and
Bearer tokens remain unchanged. When any mapping is configured, unmapped
destinations fail closed unless their host is explicitly listed in
`bot.transport_direct_hosts`. No fallback to an old gateway occurs. The same
mapping covers callbacks and launch-agent requests. Keep the router in the
network namespace containing the forwarded loopback listeners, and bind its
registry to loopback. Existing registry authentication remains mandatory in the
deployment config. Temporary tunnels must not acquire boot autostart without
separate authorization.

### Restricted attachment SSH

For a rootless Podman host, `ci/botapi_attachment_ssh.py` can be installed as
a forced command for an existing, explicitly authorized client key. It accepts
only the bridge's `docker exec <container> cat '<absolute-file>'` command,
parses it without a shell, and reads through `podman unshare`. Both Python and
Podman paths are explicit. Invoke Python with `-I` to ignore Python environment
and user-site configuration.

Place a private JSON file beside the helper, using the same basename and
`.json` suffix. Its fields are `container`, `volume_root` (the host volume
mountpoint), and `bot_directory` (exactly this bot's directory, often containing
its token). Treat that JSON as a secret: parent 0700, file 0600. Do not copy the
whole volume or grant access to other bots. Use an authorized_keys entry with
`restrict,command="/usr/bin/python3 -I /absolute/path/to/helper.py"` and preserve
all unrelated keys. This grants no shell, PTY, forwarding or user rc execution.

The helper permits only attachment subdirectories and regular files. It rejects
path traversal and symlinks in every path component; it does not expose Bot API
databases or session state. `polydaemon-attachment-check` returns a fixed probe
response without calling Telegram or disclosing the directory/token. Verify an
isolated binary fixture first, then authenticate from the actual client and
check rejection of `id` and a `cat /etc/passwd` request. A successful probe is
not proof that real attachments or the independent transport work: those remain
cutover acceptance checks after the bot's session has moved.

## State and delivery

The authoritative directory is `$HOME/.tg-copilot-bridge`, not an empty
`bot.db` at its parent. Preserve `bot.db`, `updates.db`, topic bindings, active
instances, permission overrides and the default-instance sidecar.

`updates.db` stores Telegram receipts synchronously before PTB can advance its
getUpdates offset. Receipt persistence does not wait for an agent turn.
Completed IDs suppress repeat handling; processed message bodies are removed.
After restart, only receipts whose handlers never started are replayed.
Interrupted/failed handlers become `uncertain`: inspect/reconcile them instead
of automatically repeating an approval or another external side effect.
An external action and its receipt are not a single transaction. This is not
an exactly-once guarantee, and detached background jobs have their own lifecycle.

Stop polling gracefully and wait for handlers/jobs to drain. Do not use SIGKILL
or expire the stop timeout to hurry migration. Any `processing`/`uncertain`
receipt blocks unattended cutover until reconciled. The first upgrade from
the old non-journalled version must also drain cleanly.

After all writers are stopped:

```sh
python3 ci/router_state.py snapshot /path/to/.tg-copilot-bridge /path/to/new-snapshot --writers-stopped
python3 ci/router_state.py verify /path/to/new-snapshot
```

The snapshot uses SQLite's backup API (including committed WAL), validates
JSON/SQLite integrity and records SHA256 for each file. The destination must
not exist. It contains private state and credentials: transfer over an
authenticated encrypted channel, preserve private permissions and never commit
it. Verify again at the destination, then restore only the manifest's named
files into a new private state directory. Never copy a live DB file alone.

## Bot API and activation

Follow the upstream [local-server migration procedure](https://github.com/tdlib/telegram-bot-api#moving-a-bot-from-one-local-server-to-another):
delete the webhook without dropping pending updates, call `close`, then move
only this bot's closed subdirectory to the new server. The
[`close` API](https://core.telegram.org/bots/api#close) can return 429 during
the first ten minutes after startup. A failure blocks cutover; do not bypass it
by starting another session. Do not copy another bot's session or stop a shared
Bot API indiscriminately. Prevent old clients from reopening the moved bot.

For a rootless Podman target, `ci/botapi_session.py` validates and restores a
single closed-session tar archive. Pass the exact bot directory on stdin (it
may be the token; never put it in command arguments or logs). Run the helper
inside `podman unshare`, with the verified container UID/GID, archive path and
volume mountpoint. It rejects foreign paths, links, special files, duplicate
members and an existing session directory; checks space; and applies private
permissions and verified ownership in that namespace. Do not use host UID 101
as a substitute for container UID 101. Validation does not establish that the
old session is closed or callers fenced. A failed extraction leaves a partial
new directory for explicit recovery, never an automatic overwrite retry.

Once the old router and session are fenced, the new state and attachment
directory are verified, and client paths are ready, grant the new node its
permit and start one router. Check that the old host remains unable to start
its router through boot or CI. Keep backups until acceptance is complete.

## Acceptance and rollback

For online recovery material, `ci/router_online_backup.py capture SOURCE DEST`
captures each SQLite database through the backup API and validates stable JSON
sidecars. Run it under an external process timeout; the internal deadline does
not bound all filesystem operations. DEST must be new, outside active state,
and inside a private parent directory. Accept only exit zero followed by
`ci/router_online_backup.py verify DEST`, never directory existence alone.
The manifest explicitly declares `per_file_online`, `cross_file_atomic=false`
and `automatic_restore_allowed=false`. This is not a quiesced checkpoint and
must not trigger failover or automatic replay. The helper installs no schedule,
does not stop the router, and does not back up Bot API sessions or credentials.

`ci/router_backup_job.py SOURCE ROOT --initialize` creates a new private managed
root and performs the first capture. Subsequent invocations omit `--initialize`.
It holds a nonblocking job lock, bounds each capture/verification subprocess,
and retains the last 24 successful copies by default. Unknown or incomplete
directories and quiesced checkpoints are never deleted by this retention rule.
Under the same lock, the job refuses capture if root usage plus twice the
estimated source size reaches 1 GiB, or free disk space is below the larger of
2 GiB and twice the estimate. These guards are admission checks, not a hard
filesystem quota. Investigate residues on failure instead of blind cleanup.

For a systemd oneshot, bound the entire backup cgroup with
`TimeoutStartSec=200s`, `TimeoutStopSec=10s`, `KillMode=control-group`,
`Restart=no`, and `UMask=0077`. Never put the router in that cgroup. A persistent
hourly timer may invoke the job after its initial capture and verification
succeed. A failed job must be observable; an enabled timer is not proof of a
successful recent backup. Local copies do not protect against loss of the host.

- Exactly one router and one active local Bot API session for this token.
- Registry heartbeats, chat -> intended window -> reply, existing topic history,
  inbound/outbound attachments and approval callbacks work on each client host.
- Repeat with the old gateway's PolyDaemon path isolated. A successful probe
  while the old gateway is still forwarding traffic is not independence proof.
- The old host boot cannot reactivate its router. Journal has no unreconciled
  updates; database/sidecar counts and hashes match the transferred snapshot.
- Only then may infrastructure maintenance proceed.

Rollback is another migration: stop/fence the new router first, transfer its
latest state and close/move the Bot API session, then re-enable the old host.
Never restore a stale pre-cutover DB after the new active has accepted writes.
If the new active cannot be fenced, stop and recover access; do not launch a
second poller.
