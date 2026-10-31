#!/usr/bin/env python3
"""
OpenMausBot Unified Smart Router (smart-search | smart-read | yt-inspector)
Integrated into OpenMausBot 0.1.134+ (scripts/omb-smart-tools.py)

Key Capabilities & Safeguards:
1. Parallel Multi-Engine Search: Queries Exa MCP (keyless JSON-RPC over HTTP), Tavily API,
   SearXNG (local 127.0.0.1:8888), and PubMed/Semantic Scholar (for medical/academic queries),
   with automatic fallback to Google Custom Search JSON API (preserving the 100/day free quota).
2. URL Canonicalization & RRF: Strips tracking parameters (utm_*, fbclid, gclid) before Reciprocal Rank Fusion.
3. Bilingual Reranking: Uses FlashRank (ms-marco-TinyBERT-L-2-v2) for Latin/English queries and
   normalized Persian/Arabic lexical + RRF scoring for RTL queries ([\u0600-\u06FF]).
4. SSRF-Safe 4-Layer Reader (smart-read): Blocks loopback/private/cloud-metadata IPs (protects OpenMausBot's
   127.0.0.1:8799 loopback-trust port), checks native Markdown (URL.md / llms.txt) with strict Content-Type
   verification, falls back to Jina Reader, then local Crawl4AI with disk caching.
5. Cached YouTube Inspector (yt-inspector): Caches transcripts on disk for instant follow-up questions,
   fetches native transcripts without triggering YouTube's .translate() 429 block, and compresses fallback
   audio via ffmpeg (16kHz mono 32kbps) to stay under Groq Whisper Turbo's 25MB limit.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import ipaddress
import json
import os
import re
import shutil
import socket
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

import httpx
from dotenv import load_dotenv

for env_candidate in [
    Path.home() / ".config" / "omb-search" / ".env",
    Path.home() / ".openmausbot" / ".env",
]:
    if env_candidate.is_file():
        load_dotenv(env_candidate, override=False)

SEARXNG_URL = os.getenv("SEARXNG_URL", "http://127.0.0.1:8888").rstrip("/")
EXA_MCP_URL = os.getenv("EXA_MCP_URL", "https://mcp.exa.ai/mcp").rstrip("/")
TAVILY_API_KEY = os.getenv("TAVILY_API_KEY", "").strip()
GOOGLE_CSE_API_KEY = os.getenv("GOOGLE_CSE_API_KEY", "").strip()
GOOGLE_CSE_CX = os.getenv("GOOGLE_CSE_CX", "").strip()
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "").strip()

CACHE_DIR = Path(tempfile.gettempdir()) / "omb-smart-cache"
CACHE_TTL_SECONDS = 3600

RTL_SCRIPT_RE = re.compile(r"[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]")
TRACKING_PARAMS = {
    "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
    "fbclid", "gclid", "mc_cid", "mc_eid", "ref", "yclid",
}


def canonicalize_url(url: str) -> str:
    try:
        p = urlparse(url.strip())
        if p.scheme not in ("http", "https") or not p.netloc:
            return url.strip()
        clean_query = urlencode(
            [(k, v) for k, v in parse_qsl(p.query, keep_blank_values=True) if k.lower() not in TRACKING_PARAMS]
        )
        return urlunparse((p.scheme.lower(), p.netloc.lower(), p.path.rstrip("/") or "/", p.params, clean_query, ""))
    except Exception:
        return url.strip()


def is_safe_public_url(url: str) -> bool:
    """Prevents SSRF against OpenMausBot loopback (127.0.0.1:8799) and cloud metadata (169.254.169.254)."""
    try:
        parsed = urlparse(url)
        if parsed.scheme not in ("http", "https"):
            return False
        host = (parsed.hostname or "").strip().lower()
        if not host or host in ("localhost", "0.0.0.0") or host.endswith((".local", ".internal")):
            return False
        for info in socket.getaddrinfo(host, None):
            ip_obj = ipaddress.ip_address(info[4][0])
            if (
                ip_obj.is_loopback
                or ip_obj.is_private
                or ip_obj.is_link_local
                or ip_obj.is_multicast
                or ip_obj.is_reserved
            ):
                return False
        return True
    except Exception:
        return False


def normalize_persian(text: str) -> str:
    return (
        text.replace("\u064a", "\u06cc")
        .replace("\u0643", "\u06a9")
        .replace("\u200c", " ")
        .lower()
    )


def is_rtl_query(query: str) -> bool:
    return bool(RTL_SCRIPT_RE.search(query))


def classify_query(query: str) -> str:
    q = query.lower()
    academic_terms = (
        "pubmed", "doi:", "arxiv", "clinical trial", "meta-analysis",
        "systematic review", "پزشکی", "مقاله علمی", "کارآزمایی بالینی", "دارو",
    )
    if any(t in q for t in academic_terms):
        return "academic"
    return "web"


async def search_searxng(client: httpx.AsyncClient, query: str, limit: int = 10) -> list[dict[str, Any]]:
    try:
        resp = await client.get(
            f"{SEARXNG_URL}/search",
            params={"q": query, "format": "json", "safesearch": 0},
            timeout=6.0,
        )
        resp.raise_for_status()
        data = resp.json()
        return [
            {
                "title": item.get("title", ""),
                "url": item.get("url", ""),
                "snippet": item.get("content", ""),
                "published_date": item.get("publishedDate") or item.get("pubdate"),
                "source": "searxng",
            }
            for item in data.get("results", [])[:limit]
        ]
    except Exception:
        return []


async def search_exa_mcp(client: httpx.AsyncClient, query: str, limit: int = 6) -> list[dict[str, Any]]:
    """Keyless semantic search via Exa's public MCP endpoint (same source as agent-reach)."""
    try:
        payload = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": "web_search_exa",
                "arguments": {"query": query, "numResults": limit},
            },
        }
        resp = await client.post(
            EXA_MCP_URL,
            json=payload,
            headers={"Accept": "application/json, text/event-stream"},
            timeout=7.5,
        )
        if resp.status_code != 200:
            return []
        text_body = resp.text
        data_obj: dict[str, Any] = {}
        if text_body.lstrip().startswith("{"):
            data_obj = resp.json()
        else:
            for line in text_body.splitlines():
                if line.startswith("data:"):
                    data_obj = json.loads(line[5:].strip())
                    break
        content_blocks = data_obj.get("result", {}).get("content", [])
        results: list[dict[str, Any]] = []
        for block in content_blocks:
            raw_text = block.get("text", "")
            for match in re.finditer(r"Title:\s*(.+?)\n.*?URL:\s*(\S+)\n.*?Text:\s*(.+?)(?=\nTitle:|\Z)", raw_text, re.S):
                results.append({
                    "title": match.group(1).strip(),
                    "url": match.group(2).strip(),
                    "snippet": match.group(3).strip()[:500],
                    "published_date": None,
                    "source": "exa_mcp",
                })
        return results[:limit]
    except Exception:
        return []


async def search_tavily(client: httpx.AsyncClient, query: str, limit: int = 8) -> list[dict[str, Any]]:
    if not TAVILY_API_KEY:
        return []
    try:
        resp = await client.post(
            "https://api.tavily.com/search",
            json={
                "api_key": TAVILY_API_KEY,
                "query": query,
                "search_depth": "basic",
                "max_results": limit,
            },
            timeout=8.0,
        )
        resp.raise_for_status()
        data = resp.json()
        return [
            {
                "title": r.get("title", ""),
                "url": r.get("url", ""),
                "snippet": r.get("content", ""),
                "published_date": r.get("published_date"),
                "source": "tavily",
            }
            for r in data.get("results", [])
        ]
    except Exception:
        return []


async def search_google_cse(client: httpx.AsyncClient, query: str, limit: int = 8) -> list[dict[str, Any]]:
    if not GOOGLE_CSE_API_KEY or not GOOGLE_CSE_CX:
        return []
    try:
        resp = await client.get(
            "https://customsearch.googleapis.com/customsearch/v1",
            params={"key": GOOGLE_CSE_API_KEY, "cx": GOOGLE_CSE_CX, "q": query, "num": min(limit, 10)},
            timeout=8.0,
        )
        resp.raise_for_status()
        data = resp.json()
        return [
            {
                "title": item.get("title", ""),
                "url": item.get("link", ""),
                "snippet": item.get("snippet", ""),
                "published_date": None,
                "source": "google_cse",
            }
            for item in data.get("items", [])
        ]
    except Exception:
        return []


async def search_semantic_scholar(client: httpx.AsyncClient, query: str, limit: int = 6) -> list[dict[str, Any]]:
    try:
        resp = await client.get(
            "https://api.semanticscholar.org/graph/v1/paper/search",
            params={"query": query, "limit": limit, "fields": "title,url,abstract,year"},
            timeout=8.0,
        )
        resp.raise_for_status()
        data = resp.json()
        return [
            {
                "title": item.get("title", ""),
                "url": item.get("url") or f"https://www.semanticscholar.org/paper/{item.get('paperId', '')}",
                "snippet": (item.get("abstract") or "")[:500],
                "published_date": str(item.get("year") or ""),
                "source": "semantic_scholar",
            }
            for item in data.get("data", [])
        ]
    except Exception:
        return []


async def search_pubmed(client: httpx.AsyncClient, query: str, limit: int = 5) -> list[dict[str, Any]]:
    """Keyless NCBI PubMed E-Utilities search."""
    try:
        esearch = await client.get(
            "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi",
            params={"db": "pubmed", "term": query, "retmode": "json", "retmax": limit},
            timeout=7.0,
        )
        esearch.raise_for_status()
        id_list = esearch.json().get("esearchresult", {}).get("idlist", [])
        if not id_list:
            return []
        esum = await client.get(
            "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi",
            params={"db": "pubmed", "id": ",".join(id_list), "retmode": "json"},
            timeout=7.0,
        )
        esum.raise_for_status()
        result_map = esum.json().get("result", {})
        out: list[dict[str, Any]] = []
        for pmid in id_list:
            doc = result_map.get(pmid)
            if not isinstance(doc, dict):
                continue
            out.append({
                "title": doc.get("title", ""),
                "url": f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/",
                "snippet": f"{doc.get('source', '')} ({doc.get('pubdate', '')}) - PMID: {pmid}",
                "published_date": doc.get("pubdate"),
                "source": "pubmed",
            })
        return out
    except Exception:
        return []


def rrf_merge(result_lists: list[list[dict[str, Any]]], k: int = 60) -> list[dict[str, Any]]:
    scores: dict[str, float] = {}
    items: dict[str, dict[str, Any]] = {}
    for results in result_lists:
        for rank, item in enumerate(results, start=1):
            raw_url = (item.get("url") or "").strip()
            if not raw_url:
                continue
            url = canonicalize_url(raw_url)
            scores[url] = scores.get(url, 0.0) + 1.0 / (k + rank)
            if url not in items or len(item.get("snippet", "")) > len(items[url].get("snippet", "")):
                items[url] = {**item, "url": raw_url}
    merged = []
    for url, score in sorted(scores.items(), key=lambda x: x[1], reverse=True):
        entry = items[url]
        entry["rrf_score"] = round(score, 5)
        merged.append(entry)
    return merged


def rerank_passages(query: str, candidates: list[dict[str, Any]], top_k: int = 5) -> list[dict[str, Any]]:
    if len(candidates) <= top_k:
        return candidates

    if is_rtl_query(query):
        q_tokens = set(re.findall(r"[\w\u0600-\u06FF]{2,}", normalize_persian(query)))
        for item in candidates:
            text = normalize_persian(f"{item.get('title', '')} {item.get('snippet', '')}")
            overlap = sum(1 for tok in q_tokens if tok in text)
            item["rerank_score"] = round(item.get("rrf_score", 0.0) * 10 + overlap * 0.25, 4)
        return sorted(candidates, key=lambda x: x["rerank_score"], reverse=True)[:top_k]

    try:
        from flashrank import Ranker, RerankRequest  # type: ignore

        ranker = Ranker(model_name="ms-marco-TinyBERT-L-2-v2", cache_dir=str(CACHE_DIR / "flashrank"))
        passages = [
            {
                "id": idx,
                "text": f"{c.get('title', '')}\n{c.get('snippet', '')}".strip(),
                "meta": c,
            }
            for idx, c in enumerate(candidates[:20])
        ]
        ranked = ranker.rerank(RerankRequest(query=query, passages=passages))
        out = []
        for r in ranked[:top_k]:
            meta = dict(r["meta"])
            meta["rerank_score"] = round(float(r.get("score", 0.0)), 4)
            out.append(meta)
        return out
    except Exception:
        return candidates[:top_k]


async def run_smart_search(query: str, top_k: int = 5) -> dict[str, Any]:
    category = classify_query(query)
    async with httpx.AsyncClient(follow_redirects=True) as client:
        tasks = [
            search_searxng(client, query),
            search_exa_mcp(client, query),
            search_tavily(client, query),
        ]
        if category == "academic":
            tasks.append(search_semantic_scholar(client, query))
            tasks.append(search_pubmed(client, query))
        lists = await asyncio.gather(*tasks)

        if not lists[0]:
            cse_results = await search_google_cse(client, query)
            if cse_results:
                lists.append(cse_results)

    merged = rrf_merge(lists)
    final_results = rerank_passages(query, merged, top_k=top_k)
    return {
        "query": query,
        "category": category,
        "total_candidates": len(merged),
        "results": final_results,
    }


def looks_like_clean_markdown(text: str, content_type: str) -> bool:
    ct = content_type.lower()
    stripped = text.lstrip()
    if stripped.lower().startswith(("<!doctype html", "<html", "<head", "<body")):
        return False
    if "text/html" in ct:
        return False
    return len(stripped) > 64


async def run_smart_read(url: str, max_chars: int = 32000) -> dict[str, Any]:
    if not is_safe_public_url(url):
        return {
            "url": url,
            "layer": "blocked_ssrf",
            "error": "Refused to fetch private, loopback, or non-HTTP(S) address.",
        }

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    url_hash = hashlib.sha256(canonicalize_url(url).encode("utf8")).hexdigest()[:24]
    cache_file = CACHE_DIR / f"read-{url_hash}.json"
    if cache_file.is_file() and (time.time() - cache_file.stat().st_mtime) < CACHE_TTL_SECONDS:
        cached = json.loads(cache_file.read_text("utf8"))
        cached["markdown"] = cached.get("markdown", "")[:max_chars]
        return cached

    parsed = urlparse(url)
    base_origin = f"{parsed.scheme}://{parsed.netloc}"

    async with httpx.AsyncClient(follow_redirects=True, headers={"User-Agent": "OpenMausBot-SmartRead/1.0"}) as client:
        layer1_candidates = []
        if not parsed.path.endswith(".md") and parsed.path not in ("", "/"):
            layer1_candidates.append(f"{base_origin}{parsed.path.rstrip('/')}.md")
        layer1_candidates.append(f"{base_origin}/llms.txt")

        for candidate in layer1_candidates:
            if not is_safe_public_url(candidate):
                continue
            try:
                resp = await client.get(candidate, timeout=1.8)
                if resp.status_code == 200 and looks_like_clean_markdown(resp.text, resp.headers.get("content-type", "")):
                    payload = {"url": url, "layer": "native_markdown", "source_url": candidate, "markdown": resp.text[:max_chars]}
                    cache_file.write_text(json.dumps(payload, ensure_ascii=False), "utf8")
                    return payload
            except Exception:
                pass

        try:
            jina_resp = await client.get(
                f"https://r.jina.ai/{url}",
                headers={"Accept": "text/plain"},
                timeout=10.0,
            )
            if jina_resp.status_code == 200 and len(jina_resp.text.strip()) > 120:
                payload = {"url": url, "layer": "jina_reader", "markdown": jina_resp.text[:max_chars]}
                cache_file.write_text(json.dumps(payload, ensure_ascii=False), "utf8")
                return payload
        except Exception:
            pass

    crwl_bin = shutil.which("crwl") or shutil.which("crawl4ai")
    if crwl_bin:
        try:
            proc = subprocess.run(
                [crwl_bin, url, "-o", "markdown"],
                capture_output=True,
                text=True,
                timeout=35,
            )
            if proc.returncode == 0 and len(proc.stdout.strip()) > 80:
                payload = {"url": url, "layer": "crawl4ai", "markdown": proc.stdout[:max_chars]}
                cache_file.write_text(json.dumps(payload, ensure_ascii=False), "utf8")
                return payload
        except Exception:
            pass

    return {
        "url": url,
        "layer": "requires_interactive_browser",
        "error": "Static/headless extraction failed or page requires login. Use OpenMausBot's interactive browser tool.",
    }


def extract_video_id(url_or_id: str) -> str | None:
    patterns = [
        r"(?:v=|youtu\.be/|shorts/|embed/)([A-Za-z0-9_-]{11})",
        r"^([A-Za-z0-9_-]{11})$",
    ]
    for pat in patterns:
        m = re.search(pat, url_or_id)
        if m:
            return m.group(1)
    return None


def chunk_transcript(entries: list[dict[str, Any]], window_sec: int = 120) -> list[dict[str, Any]]:
    chunks: list[dict[str, Any]] = []
    current_texts: list[str] = []
    bucket_start: int | None = None

    for item in entries:
        start = int(float(item.get("start", 0)))
        text = str(item.get("text", "")).strip()
        if not text:
            continue
        if bucket_start is None:
            bucket_start = start
        if start - bucket_start >= window_sec and current_texts:
            chunks.append({
                "start": bucket_start,
                "end": start,
                "label": f"[{bucket_start // 60:02d}:{bucket_start % 60:02d} - {start // 60:02d}:{start % 60:02d}]",
                "text": " ".join(current_texts),
            })
            bucket_start = start
            current_texts = [text]
        else:
            current_texts.append(text)

    if current_texts and bucket_start is not None:
        end_sec = bucket_start + window_sec
        chunks.append({
            "start": bucket_start,
            "end": end_sec,
            "label": f"[{bucket_start // 60:02d}:{bucket_start % 60:02d} - {end_sec // 60:02d}:{end_sec % 60:02d}]",
            "text": " ".join(current_texts),
        })
    return chunks


def fetch_yt_transcript(video_id: str) -> list[dict[str, Any]]:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    yt_cache = CACHE_DIR / f"yt-{video_id}.json"
    if yt_cache.is_file() and (time.time() - yt_cache.stat().st_mtime) < 86400:
        return json.loads(yt_cache.read_text("utf8"))

    try:
        from youtube_transcript_api import YouTubeTranscriptApi  # type: ignore

        transcript_list = YouTubeTranscriptApi.list_transcripts(video_id)
        for lang_priority in (["fa", "en", "en-US", "en-GB"], None):
            try:
                if lang_priority:
                    tr = transcript_list.find_transcript(lang_priority)
                else:
                    tr = next(iter(transcript_list))
                fetched = tr.fetch()
                entries = [
                    {"start": item["start"] if isinstance(item, dict) else getattr(item, "start", 0),
                     "text": item["text"] if isinstance(item, dict) else getattr(item, "text", "")}
                    for item in fetched
                ]
                if entries:
                    yt_cache.write_text(json.dumps(entries, ensure_ascii=False), "utf8")
                    return entries
            except Exception:
                continue
    except Exception:
        pass
    return []


def transcribe_with_groq(video_id: str) -> list[dict[str, Any]]:
    if not GROQ_API_KEY:
        return []
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    yt_cache = CACHE_DIR / f"yt-{video_id}.json"
    with tempfile.TemporaryDirectory(prefix="omb-yt-") as tmp:
        raw_audio = Path(tmp) / "audio.m4a"
        compact_audio = Path(tmp) / "compact.mp3"
        url = f"https://www.youtube.com/watch?v={video_id}"
        dl = subprocess.run(
            ["yt-dlp", "-f", "ba[abr<=64]/worstaudio", "-o", str(raw_audio), url],
            capture_output=True,
            text=True,
            timeout=120,
        )
        if dl.returncode != 0 or not raw_audio.exists():
            return []
        ff = subprocess.run(
            ["ffmpeg", "-y", "-i", str(raw_audio), "-ac", "1", "-ar", "16000", "-b:a", "32k", str(compact_audio)],
            capture_output=True,
            timeout=90,
        )
        target_file = compact_audio if (ff.returncode == 0 and compact_audio.exists()) else raw_audio
        if target_file.stat().st_size > 24 * 1024 * 1024:
            return []
        try:
            from groq import Groq  # type: ignore

            client = Groq(api_key=GROQ_API_KEY)
            with open(target_file, "rb") as audio_f:
                res = client.audio.transcriptions.create(
                    file=(target_file.name, audio_f.read()),
                    model="whisper-large-v3-turbo",
                    response_format="verbose_json",
                )
            segments = getattr(res, "segments", None) or []
            entries = [{"start": s.get("start", 0), "text": s.get("text", "")} for s in segments]
            if entries:
                yt_cache.write_text(json.dumps(entries, ensure_ascii=False), "utf8")
            return entries
        except Exception:
            return []


def run_yt_inspector(query_or_url: str, question: str, top_k: int = 5) -> dict[str, Any]:
    vid = extract_video_id(query_or_url)
    video_ids = [vid] if vid else []
    if not video_ids:
        proc = subprocess.run(
            ["yt-dlp", "--flat-playlist", "--print", "id", f"ytsearch3:{query_or_url}"],
            capture_output=True,
            text=True,
            timeout=25,
        )
        video_ids = [line.strip() for line in proc.stdout.splitlines() if len(line.strip()) == 11][:3]

    candidates: list[dict[str, Any]] = []
    for v_id in video_ids:
        entries = fetch_yt_transcript(v_id) or transcribe_with_groq(v_id)
        for ch in chunk_transcript(entries, window_sec=120):
            candidates.append({
                "title": f"YouTube {v_id} {ch['label']}",
                "url": f"https://youtu.be/{v_id}?t={ch['start']}",
                "snippet": ch["text"],
                "video_id": v_id,
                "timestamp": ch["label"],
                "rrf_score": 0.1,
            })

    ranked = rerank_passages(question or query_or_url, candidates, top_k=top_k)
    return {
        "target": query_or_url,
        "question": question,
        "matched_segments": ranked,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="OpenMausBot Smart Search, Read & YouTube Router")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_search = sub.add_parser("smart-search")
    p_search.add_argument("query", help="Search query")
    p_search.add_argument("--top-k", type=int, default=5)

    p_read = sub.add_parser("smart-read")
    p_read.add_argument("url", help="Target URL to extract")
    p_read.add_argument("--max-chars", type=int, default=32000)

    p_yt = sub.add_parser("yt-inspector")
    p_yt.add_argument("target", help="YouTube URL or topic query")
    p_yt.add_argument("--question", default="", help="Specific question to locate in transcript")

    args = parser.parse_args()
    if args.cmd == "smart-search":
        out = asyncio.run(run_smart_search(args.query, top_k=args.top_k))
    elif args.cmd == "smart-read":
        out = asyncio.run(run_smart_read(args.url, max_chars=args.max_chars))
    else:
        out = run_yt_inspector(args.target, args.question)

    print(json.dumps(out, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()