---
name: omb-smart-tools
description: "Compatibility entry for the canonical search-tool-routing skill."
---

Use the `search-tool-routing` guide for all routing and safety rules. Never use system Python.

- `/home/ubuntu/projects/openmausbot-smart-release-20261031/release/bin/smart-search "query"`
- `/home/ubuntu/projects/openmausbot-smart-release-20261031/release/bin/smart-read "https://example.com/article"`
- `/home/ubuntu/projects/openmausbot-smart-release-20261031/release/bin/yt-inspector "video URL or topic" --question "question"`

Inspect `sources` and failure statuses; do not treat empty results as verified content. Use OpenMausBot's browser for private/logged-in pages. Do not expose credentials.
