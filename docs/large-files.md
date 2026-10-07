# Large files — up to 2 GB, both ways

A window can hand you files: a build you want on your phone, an installer, a
video, a log too big to paste. And you can hand files to a window. How big depends
on which Bot API server the bot talks to.

| | Cloud Bot API (default) | Your own Bot API server |
|---|---|---|
| A window **sends** you a file | up to **50 MB** | up to **1990 MB** |
| You **send** a window a file | limited by the cloud API | no size limit |

The sending limits are the plugin's own (`MAX_ATTACHMENT_BYTES` in
`channel-plugin/src/bot-api.ts`). With your own server Telegram allows uploads up
to 2000 MB; the plugin stops at 1990 to leave a margin. With your own server in
local mode, Telegram's documentation says it will
["download files without a size limit. Upload files up to 2000 MB"](https://core.telegram.org/bots/api#using-a-local-bot-api-server).

A window sends a file through the `reply` tool's `files` parameter — absolute
paths; images arrive inline, everything else as documents. Ask for it in plain
words: *"build the release and send me the installer"*.

## Running your own server

The server is Telegram's own open-source
[telegram-bot-api](https://github.com/tdlib/telegram-bot-api).

1. **Get an API id and hash** for your Telegram account:
   <https://core.telegram.org/api/obtaining_api_id>. They identify the server to
   Telegram; they are not the bot token.

2. **Build and run it in local mode** — the build steps are in its README. Run it
   with your id and hash, and `--local`, which is the mode that lifts the limits:

   ```sh
   telegram-bot-api --api-id <id> --api-hash <hash> --local
   ```

   It also reads `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` from the environment,
   which suits a container.

3. **Log the bot out of the cloud server, once.** The server's README is explicit:
   to receive all updates, the bot must be deregistered from `api.telegram.org`
   with the `logOut` method before it is used through your server:

   ```sh
   curl https://api.telegram.org/bot<your-bot-token>/logOut
   ```

4. **Point the bot at it** — in `tg-bot/config.yaml`:

   ```yaml
   telegram:
     api_base_url: "http://127.0.0.1:8081"   # wherever your server listens
     use_local_bot_api: true
   ```

5. **Point every plugin at it** — set `TG_API_ROOT=http://127.0.0.1:8081` (your
   server's address) in `~/.config/polydaemon/machine.env` on every machine, and
   re-run `python3 hooks/install.py --mcp` there.

   The bot and every plugin must use the **same** server. A plugin left on the
   cloud API keeps the 50 MB cap without saying so — which is exactly how this
   was once found, with files quietly cut at 50 MB. The MCP entry can live in
   more than one place, and all of them must agree; see section 3 of
   [configuration.md](reference/configuration.md).

## Receiving files when the server runs in Docker

In local mode the server does not return a download URL: `file_path` is an
absolute path **on the server's own disk**. If the server runs in a container —
usual, and often on another machine — the plugin has to fetch the bytes from
there. Tell it how with the `TG_BOTAPI_*` variables:

| Variable | Meaning |
|---|---|
| `TG_BOTAPI_DOCKER` | The docker command — default `docker`, or `wsl docker` on Windows. |
| `TG_BOTAPI_CONTAINER` | The server's container name — default `telegram-bot-api`. |
| `TG_BOTAPI_SSH` | The host it runs on, if not this one; the plugin then streams the file over `ssh <host> docker exec … cat`. That user must be in the `docker` group there. |
| `TG_BOTAPI_WORKDIR` | What relative `file_path`s are relative to. |

Details in [configuration.md](reference/configuration.md).

Sending needs none of this — only receiving does.
