#!/usr/bin/env bash
# Installs the OMB smart-search stack: env template, CLI wrappers, Python
# dependencies, the local SearXNG container and the native skill link.
# NOT run automatically: the owner reviews and runs it by hand.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "[1/5] Preparing ~/.config/omb-search/.env ..."
mkdir -p "$HOME/.config/omb-search"
if [ ! -f "$HOME/.config/omb-search/.env" ]; then
  cat << 'EOF' > "$HOME/.config/omb-search/.env"
GROQ_API_KEY=""
TAVILY_API_KEY=""
GOOGLE_CSE_API_KEY=""
GOOGLE_CSE_CX=""
SEARXNG_URL="http://127.0.0.1:8888"
EOF
  chmod 600 "$HOME/.config/omb-search/.env"
  echo "Created $HOME/.config/omb-search/.env (fill in your API keys)."
fi

echo "[2/5] Installing CLI wrappers to /usr/local/bin ..."
sudo install -m 0755 "$REPO_ROOT/scripts/omb-smart-tools.py" /usr/local/bin/omb-smart-tools
printf '#!/bin/sh\nexec /usr/local/bin/omb-smart-tools smart-search "$@"\n' | sudo tee /usr/local/bin/smart-search >/dev/null
printf '#!/bin/sh\nexec /usr/local/bin/omb-smart-tools smart-read "$@"\n' | sudo tee /usr/local/bin/smart-read >/dev/null
printf '#!/bin/sh\nexec /usr/local/bin/omb-smart-tools yt-inspector "$@"\n' | sudo tee /usr/local/bin/yt-inspector >/dev/null
sudo chmod +x /usr/local/bin/smart-search /usr/local/bin/smart-read /usr/local/bin/yt-inspector

echo "[3/5] Installing Python dependencies (httpx, dotenv, flashrank, youtube-transcript-api, groq, crawl4ai) ..."
if command -v uv >/dev/null 2>&1; then
  uv tool install crawl4ai || true
  crawl4ai-setup || true
  uv pip install --system youtube-transcript-api flashrank httpx groq python-dotenv
else
  pip3 install --break-system-packages youtube-transcript-api flashrank httpx groq python-dotenv
fi

echo "[4/5] Starting local SearXNG container on 127.0.0.1:8888 ..."
if command -v docker >/dev/null 2>&1; then
  mkdir -p "$HOME/.openmausbot/searxng"
  cp "$REPO_ROOT/deploy/searxng/settings.yml" "$HOME/.openmausbot/searxng/settings.yml"
  sed -i "s/openmausbot-local-searxng-secret/$(openssl rand -hex 32)/" "$HOME/.openmausbot/searxng/settings.yml"
  docker rm -f searxng >/dev/null 2>&1 || true
  docker run -d --name searxng \
    -p 127.0.0.1:8888:8080 \
    -v "$HOME/.openmausbot/searxng/settings.yml:/etc/searxng/settings.yml:ro" \
    --restart unless-stopped \
    docker.io/searxng/searxng:latest
fi

echo "[5/5] Installing native skill into ~/.claude/skills/search-tool-routing ..."
mkdir -p "$HOME/.claude/skills/search-tool-routing"
cp "$REPO_ROOT/skills/search-tool-routing/SKILL.md" "$HOME/.claude/skills/search-tool-routing/SKILL.md"
echo "Done! Test with: smart-search 'OpenMausBot'"
