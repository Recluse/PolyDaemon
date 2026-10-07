# PolyDaemon router bot - container image.
# Build context = this tg-bot/ directory:
#   docker build -t tg-bridge-bot ./tg-bot
# The bot loads config.yaml from next to tgbridge.py (/app/config.yaml) and keeps
# all state under $HOME/.tg-copilot-bridge — so mount a config and a state volume:
#   docker run --rm \
#     -v /srv/tg-bridge/config.yaml:/app/config.yaml:ro \
#     -v tg-bridge-state:/data \
#     -p 198.51.100.2:8090:8090 \
#     --network <telegram-bot-api's network> \
#     tg-bridge-bot
# Publishing 8090 via Docker reaches it through DNAT+forward (policy accept), so no
# host nft INPUT rule is needed — same path as the telegram-bot-api container.
FROM python:3.13-slim

# HOME drives the state dir (bot.py paths: ~/.tg-copilot-bridge). Point it at the
# mounted volume so bot.db etc. persist across recreates.
ENV HOME=/data \
    PYTHONUNBUFFERED=1

WORKDIR /app

# Deps first for layer caching.
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

# Bot source (bot/, bridge/, utils/, tgbridge.py). config.yaml is NOT baked in —
# mount the real one at runtime (it carries the token + enroll secret).
COPY . /app/

# The commit this image was built from, for /versions (the image has no git).
# CI passes it: --build-arg POLYDAEMON_SHA=$CI_COMMIT_SHORT_SHA
ARG POLYDAEMON_SHA=""
ENV POLYDAEMON_SHA=$POLYDAEMON_SHA

RUN mkdir -p /data
VOLUME ["/data"]

CMD ["python", "tgbridge.py"]
