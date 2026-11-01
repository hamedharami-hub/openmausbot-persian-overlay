---
name: search-tool-routing
description: "Public web and news search, page extraction, academic lookup and timestamped YouTube transcripts."
---

# Smart tools 1.1.0

Use the release's executables, not system Python. Each executable selects the isolated Python and installed dependencies.

- Search: `/home/ubuntu/projects/openmausbot-136-release-20261101/release/bin/smart-search "query" --top-k 5`
- Australian/local lookup: same command with `--region au-en`.
- News: same command with `--kind news`; use `--fresh` to bypass the five-minute search cache.
- Page: `/home/ubuntu/projects/openmausbot-136-release-20261101/release/bin/smart-read "https://example.com/article"`
- Video/topic: `/home/ubuntu/projects/openmausbot-136-release-20261101/release/bin/yt-inspector "URL or topic" --question "question"`

Search combines SearXNG, Exa and configured Tavily; academic queries add PubMed/Semantic Scholar. DDGS backs up sparse results and handles regional/news requests. Inspect `sources`: disabled, errors and empty results are not successful searches. No results means no evidence, not that the subject does not exist.

Read original sources before asserting important facts: snippets are leads, not page reads. The reader tries same-path Markdown, local extraction, then public Jina Reader. It never substitutes the site's llms.txt for the requested page. `requires_interactive_browser` means use OpenMausBot's existing browser. Login, clicking, forms, uploads and authenticated pages always use that browser directly; never send private data or credential-bearing URLs to public readers.

YouTube uses native transcripts, then yt-dlp subtitles, then configured Groq speech recognition. `no_transcript` or an error means no video content was retrieved. Do not infer contents from titles. Returned segments are excerpts, not proof the complete video was viewed.

For library/API documentation use Context7 first only when its tools are actually mounted; otherwise search official documentation. Never claim a configured tool is available without evidence. A regional search does not guarantee current opening hours; check the original site.

Credentials belong only in `~/.config/omb-search/.env`, permissions 0600. Never print or copy them into chat.
