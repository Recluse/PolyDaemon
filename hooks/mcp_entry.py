"""Register the channel plugin with Claude Code from one per-machine file.

    python3 hooks/install.py --mcp             # register / update the tg-bridge MCP server
    python3 hooks/install.py --mcp --dry-run   # show the entry (secrets masked), change nothing
    python3 hooks/install.py --mcp --codex     # Codex only (codex mcp add)
    python3 hooks/install.py --mcp --opencode  # OpenCode V2 discovery loader

Everything machine-specific — the bot token, the shared secret, this machine's
address in a multi-machine setup — lives in ONE local file,
~/.config/polydaemon/machine.env (template: machine.env.example in the repo).
It never enters the repository and never travels through the bot. This builds
the `tg-bridge` entry from it and registers it at user scope through Claude
Code's own `claude mcp add-json`, rather than editing ~/.claude.json by hand:
Claude Code rewrites that file constantly, and a hand edit races it.

A `git pull` can change the SHAPE of the entry (a new variable, a new path);
re-running this applies it with the same local values.

Known limit: `claude mcp add-json` and `codex mcp add` take the entry on their
command line, so while each runs (a fraction of a second) the token is visible
to other local users in the process list — the same as typing `claude mcp add
-e …` by hand. On a machine shared with people you do not trust, write the entry
yourself.
"""
from __future__ import annotations

import json
import os
import pathlib
import re
import shutil
import subprocess

MACHINE_ENV = pathlib.Path.home() / ".config" / "polydaemon" / "machine.env"
REQUIRED = ("TG_BOT_TOKEN", "TG_BRIDGE_AUTH_TOKEN")
# Set per WINDOW by the launchers, never per machine.
PER_WINDOW = {"TG_BRIDGE_INSTANCE_NAME", "TG_WINDOW_UID"}


def plugin_env_keys(repo: pathlib.Path) -> set[str]:
    """Every TG_* variable the plugin reads — taken from its source, so this list
    cannot fall behind the plugin."""
    names: set[str] = set()
    for f in [repo / "channel-plugin" / "server.ts", *(repo / "channel-plugin" / "src").glob("*.ts")]:
        names |= set(re.findall(r"\benv\.(TG_[A-Z0-9_]+)", f.read_text(encoding="utf-8")))
    return names - PER_WINDOW


def parse_env(text: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for n, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:]
        key, sep, value = line.partition("=")
        if not sep:
            raise ValueError(f"line {n}: expected KEY=VALUE, got {raw!r}")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        out[key.strip()] = value
    return out


def build_entry(env: dict[str, str], repo: pathlib.Path, known: set[str]) -> dict:
    missing = [k for k in REQUIRED if not env.get(k)]
    if missing:
        raise ValueError(f"missing in {MACHINE_ENV}: {', '.join(missing)}")
    unknown = sorted(set(env) - known)
    if unknown:
        # A typo'd name is silently ignored by the plugin — refuse instead.
        raise ValueError(f"unknown variable(s): {', '.join(unknown)} — the plugin reads: {', '.join(sorted(known))}")
    return {
        "type": "stdio",
        "command": "bun",
        "args": ["run", str(repo / "channel-plugin" / "server.ts")],
        "env": {k: v for k, v in env.items() if v != ""},
    }


def masked(entry: dict) -> dict:
    env = {k: (v[:4] + "…" if ("TOKEN" in k or "SECRET" in k) and v else v) for k, v in entry["env"].items()}
    return {**entry, "env": env}


def register_codex(entry: dict) -> int:
    """The same entry for Codex windows, through `codex mcp add` (it writes
    ~/.codex/config.toml itself)."""
    codex = shutil.which("codex")
    if not codex:
        print("`codex` is not on PATH — skipped Codex")
        return 1
    subprocess.run([codex, "mcp", "remove", "tg-bridge"], capture_output=True)
    env_args = [a for k, v in entry["env"].items() for a in ("--env", f"{k}={v}")]
    r = subprocess.run([codex, "mcp", "add", "tg-bridge", *env_args, "--", entry["command"], *entry["args"]],
                       capture_output=True, text=True)
    if r.returncode != 0:
        print(f"codex mcp add failed: {r.stderr.strip() or r.stdout.strip()}")
        return 1
    print("registered PolyDaemon for Codex (MCP key: tg-bridge)")
    return 0


def opencode_loader(repo: pathlib.Path, dry: bool, remove: bool = False) -> int:
    loader = pathlib.Path.home() / ".config" / "opencode" / "plugins" / "tg-bridge" / "index.ts"
    locator = MACHINE_ENV.with_name("repo-path")
    content = f'// PolyDaemon discovery loader; managed by hooks/install.py.\nexport {{ default }} from {json.dumps((repo / "clients/opencode-plugin.ts").as_uri())};\n'
    tui = loader.with_name("tui.tsx")
    tui_content = f'// PolyDaemon discovery loader; managed by hooks/install.py.\nexport {{ default }} from {json.dumps((repo / "clients/opencode-tui.tsx").as_uri())};\n'
    manifest = loader.with_name("package.json")
    package = {"name": "polydaemon-opencode", "type": "module", "exports": {".": "./index.ts", "./tui": "./tui.tsx"}}
    for path, filename in ((loader, "opencode-plugin.ts"), (tui, "opencode-tui.tsx")):
        if path.exists() and not re.fullmatch(r'(// PolyDaemon discovery loader[^\n]*\n)?export \{ default \} from [\'\"].*/clients/' + re.escape(filename) + r'[\'\"];?\s*', path.read_text(encoding="utf-8")):
            print(f"refusing to replace an unrecognised loader: {path}")
            return 1
    if manifest.exists():
        try:
            owned = json.loads(manifest.read_text(encoding="utf-8")) == package
        except ValueError:
            owned = False
        if not owned:
            print(f"refusing to replace an unrecognised manifest: {manifest}")
            return 1
    if remove:
        if not dry:
            for path in (loader, tui, manifest):
                path.unlink(missing_ok=True)
        if not dry and locator.exists() and locator.read_text(encoding="utf-8").strip() == str(repo):
            locator.unlink()
        print(f"{'would remove' if dry else 'removed'} {loader}")
        return 0
    if not dry:
        for path, value in ((loader, content), (tui, tui_content), (manifest, json.dumps(package) + "\n"), (locator, str(repo) + "\n")):
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_name(path.name + ".tmp")
            tmp.write_text(value, encoding="utf-8")
            tmp.chmod(0o600)
            os.replace(tmp, path)
    print(f"{'would register' if dry else 'registered'} OpenCode loader: {loader}")
    return 0


def uninstall(codex: bool, dry: bool = False, opencode: bool = False, repo: pathlib.Path | None = None) -> int:
    """Remove only the selected agent's entry. Absent is fine."""
    if opencode:
        return opencode_loader(repo, dry, remove=True)
    commands = (("codex", ["mcp", "remove", "tg-bridge"]),) if codex else (
        ("claude", ["mcp", "remove", "--scope", "user", "tg-bridge"]),)
    for tool, args in commands:
        if dry:
            print(f"would remove tg-bridge for {tool}")
            continue
        exe = shutil.which(tool)
        if exe:
            r = subprocess.run([exe, *args], capture_output=True, text=True)
            print(f"{tool}: {'removed tg-bridge' if r.returncode == 0 else 'no tg-bridge entry'}")
    return 0


def main(repo: pathlib.Path, dry: bool, codex: bool = False, opencode: bool = False) -> int:
    if not MACHINE_ENV.exists():
        print(f"{MACHINE_ENV} does not exist. Start from the template:\n"
              f"  mkdir -p {MACHINE_ENV.parent} && cp {repo / 'machine.env.example'} {MACHINE_ENV}\n"
              f"then fill it in (chmod 600 — it holds the bot token).")
        return 1
    try:
        # utf-8-sig: Notepad on older Windows saves a BOM, which would otherwise
        # glue itself to the first key and fail as an unknown variable.
        entry = build_entry(parse_env(MACHINE_ENV.read_text(encoding="utf-8-sig")), repo, plugin_env_keys(repo))
    except ValueError as exc:
        print(exc)
        return 1
    print(json.dumps(masked(entry), indent=2))
    if opencode:
        if not dry and not shutil.which("opencode"):
            print("`opencode` is not on PATH — install OpenCode V2 first")
            return 1
        return opencode_loader(repo, dry)
    if dry:
        print("dry run: nothing registered")
        return 0
    if codex:
        return register_codex(entry)
    claude = shutil.which("claude")
    if not claude:
        print("`claude` is not on PATH — install Claude Code first")
        return 1
    # Replace, not merge: remove the old user-scope entry (absent is fine).
    subprocess.run([claude, "mcp", "remove", "--scope", "user", "tg-bridge"], capture_output=True)
    r = subprocess.run([claude, "mcp", "add-json", "--scope", "user", "tg-bridge", json.dumps(entry)],
                       capture_output=True, text=True)
    if r.returncode != 0:
        print(f"claude mcp add-json failed: {r.stderr.strip() or r.stdout.strip()}")
        return 1
    print("registered PolyDaemon at user scope (MCP key: tg-bridge); new windows use it")
    return 0


def self_check() -> None:
    repo = pathlib.Path(__file__).resolve().parent.parent
    known = plugin_env_keys(repo)
    assert {"TG_BOT_TOKEN", "TG_BRIDGE_BOT_URL", "TG_API_ROOT"} <= known
    assert not known & PER_WINDOW, "per-window variables never come from the machine file"
    env = parse_env('# c\nTG_BOT_TOKEN="123:abc"\nexport TG_BRIDGE_AUTH_TOKEN=s3cret\n\nTG_API_ROOT=\n')
    assert env == {"TG_BOT_TOKEN": "123:abc", "TG_BRIDGE_AUTH_TOKEN": "s3cret", "TG_API_ROOT": ""}
    e = build_entry(env, repo, known)
    assert "TG_API_ROOT" not in e["env"], "an empty value means 'not set', not an empty variable"
    assert e["args"][1].endswith("channel-plugin/server.ts") or e["args"][1].endswith("channel-plugin\\server.ts")
    assert masked(e)["env"]["TG_BOT_TOKEN"] == "123:…" and e["env"]["TG_BOT_TOKEN"] == "123:abc"
    for bad, why in [({"TG_BOT_TOKEN": "x"}, "missing"), ({**env, "TG_BOT_TOKNE": "x"}, "unknown")]:
        try:
            build_entry(bad, repo, known)
            raise AssertionError(why)
        except ValueError as exc:
            assert why in str(exc), exc
    try:
        parse_env("no equals sign")
        raise AssertionError("a line without = is an error")
    except ValueError:
        pass
    print("mcp_entry self-check OK")


if __name__ == "__main__":
    self_check()
