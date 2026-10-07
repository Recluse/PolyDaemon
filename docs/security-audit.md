# Initial source publication review

Review date: 2026-10-07. This is a source review with targeted regression
tests, not an independent penetration test or a security certification.

## Scope

The review covered the public export boundary, authentication and Telegram user
allowlist, approval and plan decisions, window/topic routing, local registry
writes, project file access, OpenCode prompt admission, launchers, installation
instructions and the isolated CI checks. The public repository starts with one
source snapshot; private history, machine configuration and the unfinished board
application are excluded.

## Findings fixed before publication

| Severity | Finding | Resolution and regression |
|---|---|---|
| High | The daemon interpreted a plan decision without `action` as `apply`. | Only explicit `apply` or `decline` is forwarded. `agent/resolve.test.ts` exercises the actual authenticated daemon and a local callback endpoint. |
| Medium | A plan button could be pressed before its pending request existed. | Pending state is registered before sending the button, and cleaned up on send failure. `channel-plugin/src/approvals.test.ts` sends the callback before the simulated Telegram response returns. |
| Medium | The project tree followed symlinks into other directories or cycles. | Tree traversal skips symlinks; file reads retain physical-path confinement. `agent/files.test.ts` covers external links, cycles and traversal. |
| Medium | A file preview loaded the entire file before truncating its output. | Reads are bounded to 512 KiB, including short-read handling. The file regression checks the preview limit. |
| High | Local registry snapshots containing bearer tokens inherited ordinary file permissions. | Atomic snapshots and the lock database use mode 0600. The registry regression verifies the final snapshot permissions. |
| Medium | Concurrent registry read/modify/rename operations could overwrite sibling entries. | A SQLite immediate transaction serializes every registry mutation across processes, while readers keep the existing atomic JSON format. Five concurrent processes exercise upsert, heartbeat and removal. |

Plan delivery also uses the registered forum binding before the first inbound
message, matching ordinary approval delivery. Invalid plan callback bodies fail
closed. These changes do not establish the cause of any historical approval
incident.

## Verification

Run `python ci/check.py` with Bun 1.3.x, Node, gitleaks and the Python dependencies
from `tg-bot/requirements.txt` installed. The check scans the public tree for
secrets, installs the locked Bun dependencies and runs tests under isolated user
homes with fixture credentials and loopback endpoints. No real model, Telegram
approval, push or deployment is performed by these tests.

The first publication is a clean tree with no private commit history. Its
contents and local documentation links are checked before the initial commit.

## Remaining boundaries

- This is a single-owner remote-control tool. Authorized Telegram users and
  holders of bridge credentials are trusted; window names are not security
  principals. Use loopback or a private network, as documented in the setup guide.
- Command classification is not a shell sandbox. Native agent restrictions
  remain necessary for untrusted code and indirect operations inside scripts.
- Existing plugin processes must restart to load registry fixes. During an
  upgrade, older processes do not participate in the new registry lock.
- macOS checks do not establish native Windows/Linux agent acceptance. See
  [platforms.md](platforms.md) for the remaining platform and fresh-install gaps.
- OpenCode delivery is at least once with stable native message IDs; it does
  not promise exactly-once external effects after a crash.
- Optional memory and code-navigation servers have their own configuration,
  access policies and security lifecycle.
