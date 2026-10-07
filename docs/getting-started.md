# Getting started — everything on one machine

This takes one computer from nothing to "I message a bot, and an agent
window answers". Everything runs locally: the bot, the bridge and agent adapter.
Running windows on several machines against one bot is a later step, covered in
[multi-machine.md](multi-machine.md).

## What you need

- **An agent:** Claude Code 2.1.80+, Codex, or OpenCode V2 (tested with 2.0.22)
- **Bun 1.3.x** — runs the channel plugin
- **Python 3.11+** — runs the bot
- **Node 22.5+** — runs the hooks (the fallback registry lookup uses `node:sqlite`)
- A Telegram account

Get the public source; no configuration from another installation is needed:

```sh
git clone https://github.com/Recluse/PolyDaemon.git
cd PolyDaemon
```

Steps 1-4 and the dependency/machine file setup in step 5 are shared. For
Codex, then follow [codex.md](codex.md); for OpenCode, follow
[opencode.md](opencode.md). Do not run the Claude registration or hook commands
for those agents. The remaining steps below describe the Claude adapter.

## 1. Create the bot

In Telegram, talk to **@BotFather**, send `/newbot`, and follow the prompts. Keep
the token it gives you — it looks like `123456789:AA…`. Anyone with this token
controls the bot; treat it like a password.

## 2. Configure the bot

```sh
cp tg-bot/config.yaml.example tg-bot/config.yaml
```

Edit `tg-bot/config.yaml`:

- `telegram.bot_token` — the token from step 1.
- `telegram.allowed_users` — your numeric Telegram user id. You do not know it
  yet; leave the placeholder for now, step 4 tells you.

Leave everything else as it is. The example is set up for exactly this: the cloud
Bot API, no forum group, no multi-machine registry.

> **Why the allowlist is mandatory.** The windows run in `bypassPermissions` mode
> (see step 7), so whoever the bot obeys can make Claude run any command on this
> machine. The bot refuses to start with an empty list, and anyone not on it gets
> nothing but a refusal.

## 3. Start the bot

```sh
cd tg-bot
python3 -m venv .venv
. .venv/bin/activate            # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python tgbridge.py
```

The bot reads `config.yaml` from its own folder, wherever you start it from.
Leave it running.

## 4. Find your user id

Message your bot anything. Because you are not on the allowlist yet, it refuses —
and the refusal tells you **your own** user id. Put that number in
`telegram.allowed_users`, stop the bot (Ctrl+C) and start it again. Message it
once more: this time there is no refusal.

## 5. Register the channel plugin with Claude Code

Install the plugin's dependencies:

```sh
cd channel-plugin
bun install
cd ..
```

Everything this machine needs goes into one private file, outside the
repository (commands from the repository root):

```sh
mkdir -p ~/.config/polydaemon
cp machine.env.example ~/.config/polydaemon/machine.env
chmod 600 ~/.config/polydaemon/machine.env
```

Fill in two lines:

- `TG_BOT_TOKEN` — the **same** token as the bot. The bot is the only thing that
  *reads* messages from Telegram; each plugin only *sends* its window's replies.
- `TG_BRIDGE_AUTH_TOKEN` — a random secret, from `openssl rand -hex 32`. The bot
  and the hooks use it to talk to each window.

Leave the rest empty — those are for several machines and for your own Bot API
server. Then register the plugin for your user, so every project can use it:

```sh
python3 hooks/install.py --mcp --dry-run   # shows the entry, secrets masked
python3 hooks/install.py --mcp
```

It builds the `tg-bridge` entry from that file and registers it through
`claude mcp`, so it never edits Claude Code's own files by hand. It refuses a
variable the plugin does not know, rather than let a typo be silently ignored.
Re-run it whenever you change the file or `git pull`.

## 6. Install the hooks

Approvals, questions (`AskUserQuestion`), plan approval, notifications, and the
reply mirror all work through Claude Code hooks. The installer registers them in
`~/.claude/settings.json`:

```sh
python3 hooks/install.py --dry-run    # see exactly what it will change
python3 hooks/install.py
```

It never touches hooks that are not PolyDaemon's, does not duplicate itself when
re-run, and keeps a backup of the file it edits. `--uninstall` removes only what
it added. The hooks run from this checkout, so `git pull` updates them.

## 7. Start a window

Put the launcher in the root of a project you want to reach from Telegram — copy
it or symlink it:

```sh
ln -s /absolute/path/to/this/repo/clients/polydaemon-claude.sh ~/code/my-project/polydaemon-claude.sh
cd ~/code/my-project
./polydaemon-claude.sh
```

On Windows, use `polydaemon-claude.cmd` from the repository root the same way.

The launcher starts Claude with the Telegram channel, names the window after the
folder, resumes that folder's last session when there is one, and runs in
`bypassPermissions` mode. In that mode the approval hook still sends the most
protected commands — pushes and deployments — to
Telegram for a tap before they run, and **waits for you**: an approval nobody
answers never goes through on its own.

The first start of a project asks a couple of questions in the terminal — whether
you trust the folder, and whether to load the development channel. Answer them
once, in the terminal.

## 8. Try it

Send your bot a message: *"what is in this folder?"*. A progress message appears
while Claude works, then the answer.

- `/window` — pick which window your messages go to, when several are running.
- `/status` — what is running.
- `/help` — everything else.

## When it does not work

| Symptom | Where to look |
|---|---|
| The bot does not answer at all | Is `tgbridge.py` running, and printing errors? Is `bot_token` right? |
| "Access denied" | Your id is not in `allowed_users` yet — the message tells you what it is. |
| The bot answers, but no window gets the message | Was the window started with the launcher? A plain `claude` has no channel. `claude mcp list` should show `tg-bridge`. |
| The window answers in the terminal but not in Telegram | Are the hooks installed? `python3 hooks/install.py --dry-run` says "nothing to change" when they are. |
| Approvals appear in the terminal instead of Telegram | Same — the hooks. They take effect for windows started after installing. |

## Going further

- **Topics per window** — make a Telegram group, turn on Topics, add the bot as an
  admin with "Manage Topics", run `/chatid` in the group and put the id in
  `telegram.forum_chat_id`. Each window then gets its own topic.
- **Files up to 2 GB** — on the cloud Bot API a window can send you files up to
  50 MB. With your own `telegram-bot-api` server that becomes 1990 MB, and files
  you send arrive without a size limit: [large-files.md](large-files.md).
- **Your platform** — what works on Windows, macOS and Linux:
  [platforms.md](platforms.md).
- **Several machines, one bot** — [multi-machine.md](multi-machine.md).
- **Every setting** — [reference/configuration.md](reference/configuration.md).
