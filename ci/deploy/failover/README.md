# failover pair — install on each bot host

1. Copy `polyd_failover.py`, `polyd_state_sync.py` and `router_online_backup.py`
   from `ci/` to `~/bot-api/` on both hosts.
2. Copy `failover-primary.example.json` (router-a) / `failover-reserve.example.json`
   (claude) to `~/bot-api/failover.json`, replace NODE_ID/IPs/USER and the shared
   `control_token` (same value on both hosts).
3. Copy `polyd-failover.service` to `~/.config/systemd/user/`, then
   `systemctl --user daemon-reload && systemctl --user enable --now polyd-failover`.
4. On the active host only: edit `polyd-state-sync.service` (RESERVE_HOST) and
   install it with `polyd-state-sync.timer`.
5. The controller never starts a router by itself. It only stops a reserve
   that sees the primary serving, and it logs `needs-operator:*` when a node is
   down. Activation is a manual step that comes after the cutover runbook
   (docs/runbooks/router-cutover.md):
   `python3 ~/bot-api/polyd_failover.py --config ~/bot-api/failover.json promote
   --operator-decision --fencing-evidence /abs/path/evidence.json`.

Full narrative and the client side (transport.json per OS): docs/ha-failover.md.
