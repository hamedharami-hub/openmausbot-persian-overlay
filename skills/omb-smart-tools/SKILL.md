---
name: omb-smart-tools
description: "Unified router for live web search, page reading and YouTube transcripts: smart-search, smart-read and yt-inspector. Use when the person asks to search the web, read a URL, or find what a YouTube video says."
---

# OMB Smart Tools

`smart-tools.py` sits next to this guide, in the folder named by this skill's `root`
(a byte-identical mirror of `scripts/omb-smart-tools.py`, which is the canonical copy
shipped into Docker at `/usr/local/bin/omb-smart-tools`). Run it with the Python in the box; never paste its output as if a page was read when it reports a failure.

## Commands

- Web, news or paper search (parallel SearXNG, Tavily and Semantic Scholar, RRF merge, rerank, one JSON):
  `python3 smart-tools.py smart-search "query" [--top-k 5]`
- Read one URL (native Markdown, then Jina, then local Crawl4AI, else interactive browser):
  `python3 smart-tools.py smart-read "https://…"`
- YouTube topic or URL with a question (transcript chunks with timestamps and links):
  `python3 smart-tools.py yt-inspector "query_or_url" --question "…"`
- Academic queries (PubMed terms, doi:, clinical-trial words) route to Semantic Scholar automatically.

## Rules

1. Load this skill before the first smart-tools call in the turn.
2. Answer only from text the command actually returned. A 403, login wall, paywall or browser check is a failed read: say so, do not fill it in.
3. Snippets are leads, not reads. Verify important claims on the original page.
4. Label social posts unofficial. Do not present captions as the whole video.
5. Private URLs, credentials and authenticated content never go to third-party readers.
6. If the script reports `requires_interactive_browser`, use the built-in browser, never a bypass.

## Configuration (owner only, never in chat)

Keys live in `~/.config/omb-search/.env` (the box cannot see `~/.openmausbot/.env`): `TAVILY_API_KEY`, `GOOGLE_CSE_API_KEY`, `GOOGLE_CSE_CX`, `GROQ_API_KEY`, `SEARXNG_URL` (default `http://127.0.0.1:8888`). Missing keys only disable that source; the router still answers from the rest.
