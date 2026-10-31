---
name: search-tool-routing
description: "Unified routing rules for web search (smart-search), webpage reading (smart-read), coding docs (context7 MCP), and YouTube video analysis (yt-inspector)."
---

# Smart Search, Web Read & YouTube Routing

Follow these four deterministic rules to avoid rate limits, captcha blocks, and unnecessary multi-turn retries:

1. **Web, News & Academic Search**: Run `smart-search "<query>"` in your shell. It queries SearXNG, Exa MCP, Tavily, and PubMed/Semantic Scholar in parallel, merges results via RRF, and reranks the top 5 matches. Do not call `ddgs` or scrape search engines manually.
2. **Programming & Library Documentation**: When looking up SDKs, frameworks, or API documentation, call the `context7` MCP server tools first if mounted; otherwise run `smart-search "<library> documentation"`.
3. **Reading Any URL**: Run `smart-read "<url>"` in your shell. It automatically checks native Markdown (`URL.md` / `/llms.txt`), falls back to Jina Reader, and then runs local `Crawl4AI` with disk caching.
4. **YouTube Search & Timestamped Video Analysis**: Run `yt-inspector "<video_url_or_topic>" --question "<specific question>"` to extract timestamped transcript segments (`youtu.be/ID?t=...`) via `youtube-transcript-api` or Groq Whisper Turbo.
5. **Interactive Browser Fallback**: Open the interactive browser only when `smart-read` returns `layer: "requires_interactive_browser"` or when you need to log in, click buttons, or submit a form.
