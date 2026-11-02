#!/usr/bin/env python3
"""OMB Smart Router: public search, bounded page extraction, timestamped transcripts."""

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
import contextvars
import sys
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, quote, urlencode, urlparse, urlunparse

import httpx
from dotenv import load_dotenv

for env_candidate in [
    Path.home() / ".config" / "omb-search" / ".env",
    Path.home() / ".openmausbot" / ".env",
]:
    if env_candidate.is_file():
        load_dotenv(env_candidate, override=False)

ROUTER_VERSION = "1.1.0"
SEARXNG_URL = os.getenv("SEARXNG_URL", "http://127.0.0.1:8888").rstrip("/")
EXA_MCP_URL = os.getenv("EXA_MCP_URL", "https://mcp.exa.ai/mcp").rstrip("/")
TAVILY_API_KEY = os.getenv("TAVILY_API_KEY", "").strip()
GOOGLE_CSE_API_KEY = os.getenv("GOOGLE_CSE_API_KEY", "").strip()
GOOGLE_CSE_CX = os.getenv("GOOGLE_CSE_CX", "").strip()
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "").strip()
SEMANTIC_SCHOLAR_API_KEY = os.getenv("SEMANTIC_SCHOLAR_API_KEY", "").strip()

CACHE_DIR = Path(os.getenv("OMB_SEARCH_CACHE_DIR", str(Path.home() / ".cache/omb-smart-tools-v2")))
CACHE_TTL_SECONDS = 3600
SOURCE_STATUS = contextvars.ContextVar("source_status", default=None)
SEARCH_REGION = contextvars.ContextVar("search_region", default="")
SEARCH_KIND = contextvars.ContextVar("search_kind", default="web")


def write_cache(path: Path, payload: Any) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".write-")
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(payload, stream, ensure_ascii=False)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    files = sorted(path.parent.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    for stale in files[1000:]:
        try:
            stale.unlink()
        except OSError:
            pass


def executable(name: str) -> str:
    adjacent = Path(sys.executable).parent / name
    return str(adjacent) if adjacent.is_file() else (shutil.which(name) or name)


def record_source(name: str, status: str, **details: Any) -> None:
    statuses = SOURCE_STATUS.get()
    if statuses is not None:
        statuses[name] = {"status": status, **details}


class SearchClient(httpx.AsyncClient):
    async def request(self, method, url, **kwargs):
        endpoint = httpx.URL(url)
        if not is_safe_public_url(str(endpoint)) and not (
            endpoint.scheme == "http" and endpoint.host == "127.0.0.1"
            and endpoint.port == 8888 and endpoint.path == "/search"
            and str(endpoint).rstrip("/") == SEARXNG_URL + "/search"
        ):
            raise ValueError("unsafe search endpoint")
        kwargs["follow_redirects"] = False
        name = {"mcp.exa.ai": "exa_mcp", "api.tavily.com": "tavily",
                "customsearch.googleapis.com": "google_cse", "api.semanticscholar.org": "semantic_scholar",
                "eutils.ncbi.nlm.nih.gov": "pubmed"}.get(endpoint.host, "searxng")
        try:
            if endpoint.host != "127.0.0.1":
                addresses = socket.getaddrinfo(endpoint.host, endpoint.port or (443 if endpoint.scheme == "https" else 80), type=socket.SOCK_STREAM)
                if not addresses or any(not ipaddress.ip_address(a[4][0]).is_global for a in addresses):
                    raise ValueError("unsafe search endpoint address")
                kwargs["headers"] = {**(kwargs.get("headers") or {}), "Host": endpoint.netloc.decode("ascii")}
                kwargs["extensions"] = {"sni_hostname": endpoint.host}
                address = next((a for a in addresses if a[0] == socket.AF_INET), addresses[0])
                url = endpoint.copy_with(host=address[4][0])
            response = await super().request(method, url, **kwargs)
            if response.status_code != 200:
                record_source(name, "error", http_status=response.status_code)
            return response
        except Exception as exc:
            record_source(name, "error", error=type(exc).__name__)
            raise

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
        if parsed.username is not None or parsed.password is not None:
            return False
        host = (parsed.hostname or "").strip().lower().rstrip(".")
        if not host or host in ("localhost", "0.0.0.0") or host.endswith((".local", ".internal")):
            return False
        port = parsed.port
        if port is not None and port not in (80, 443):
            return False
        for info in socket.getaddrinfo(host, None):
            ip_obj = ipaddress.ip_address(info[4][0])
            if not ip_obj.is_global:
                return False
        return True
    except Exception:
        return False


async def safe_get(client: httpx.AsyncClient, url: str, *, timeout: float, headers: dict[str, str] | None = None, hops: int = 3):
    """Fetch without letting a redirect skip the public-address check."""
    current = url
    for _ in range(hops + 1):
        if not is_safe_public_url(current):
            raise ValueError("refused non-public address")
        parsed = httpx.URL(current)
        # Pin the validated address: resolving again at connect time permits DNS rebinding.
        addresses = socket.getaddrinfo(parsed.host, parsed.port or (443 if parsed.scheme == "https" else 80), type=socket.SOCK_STREAM)
        if not addresses or any(not ipaddress.ip_address(a[4][0]).is_global for a in addresses):
            raise ValueError("refused non-public address")
        address = next((a for a in addresses if a[0] == socket.AF_INET), addresses[0])
        target_url = parsed.copy_with(host=address[4][0])
        request_headers = {**(headers or {}), "Host": parsed.netloc.decode("ascii")}
        async with client.stream("GET", target_url, timeout=timeout, headers=request_headers,
                                 follow_redirects=False, extensions={"sni_hostname": parsed.host}) as streamed:
            content = bytearray()
            async for chunk in streamed.aiter_bytes():
                content.extend(chunk)
                if len(content) > 4 * 1024 * 1024:
                    raise ValueError("response exceeds 4 MiB")
            decoded_headers = {k: v for k, v in streamed.headers.items() if k not in ("content-encoding", "content-length")}
            response = httpx.Response(streamed.status_code, headers=decoded_headers, content=bytes(content),
                                      request=httpx.Request("GET", current))
        if response.status_code in (301, 302, 303, 307, 308):
            target = response.headers.get("location")
            if not target:
                return response
            current = str(httpx.URL(current).join(target))
            continue
        return response
    raise ValueError("too many redirects")


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
            params={"q": query, "format": "json", "safesearch": 1,
                    "language": "fa-IR" if is_rtl_query(query) else "en",
                    "categories": "news" if SEARCH_KIND.get() == "news" else "general"},
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
                "arguments": {"query": query, "objective": query, "numResults": limit},
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
            for match in re.finditer(r"^Title:[ \t]*([^\n]+)\nURL:[ \t]*(\S+)\n(?:Published:[^\n]*\n)?(?:Author:[^\n]*\n)?(?:Text|Highlights):[ \t]*\n?([\s\S]+?)(?=\nTitle:|\Z)", raw_text, re.M):
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
            headers={"x-api-key": SEMANTIC_SCHOLAR_API_KEY} if SEMANTIC_SCHOLAR_API_KEY else {},
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
    if not candidates:
        return candidates

    if is_rtl_query(query):
        q_tokens = set(re.findall(r"[\w\u0600-\u06FF]{2,}", normalize_persian(query)))
        for item in candidates:
            text = normalize_persian(f"{item.get('title', '')} {item.get('snippet', '')}")
            overlap = sum(1 for tok in q_tokens if tok in text)
            item["rerank_score"] = round(item.get("rrf_score", 0.0) * 10 + overlap * 0.25, 4)
        record_source("reranker", "ok", method="persian_lexical_rrf")
        return sorted(candidates, key=lambda x: x["rerank_score"], reverse=True)[:top_k]

    try:
        from flashrank import Ranker, RerankRequest  # type: ignore

        ranker = Ranker(model_name="ms-marco-TinyBERT-L-2-v2", cache_dir=str(CACHE_DIR / "flashrank"), max_length=256)
        passages = [
            {
                "id": idx,
                "text": f"{c.get('title', '')}\n{c.get('snippet', '')}".strip(),
                "meta": c,
            }
            for idx, c in enumerate(candidates[:20])
        ]
        ranked = ranker.rerank(RerankRequest(query=query, passages=passages))
        record_source("reranker", "ok", method="flashrank")
        out = []
        for r in ranked[:top_k]:
            meta = dict(r["meta"])
            meta["rerank_score"] = round(float(r.get("score", 0.0)), 4)
            out.append(meta)
        return out
    except Exception as exc:
        record_source("reranker", "fallback_rrf", error=type(exc).__name__)
        return candidates[:top_k]


def ddgs_worker(query: str, region: str, kind: str) -> list[dict[str, Any]]:
    from ddgs import DDGS
    engine = DDGS(timeout=5)
    method = engine.news if kind == "news" else engine.text
    return [{"title": row.get("title", ""), "url": row.get("href") or row.get("url", ""),
             "snippet": row.get("body", ""), "source": "ddgs", "published_date": row.get("date")}
            for row in method(query, region=region, max_results=8)]


async def search_ddgs(query: str) -> list[dict[str, Any]]:
    proc = await asyncio.create_subprocess_exec(
        __import__("sys").executable, str(Path(__file__).resolve()), "_ddgs", query,
        "--region", SEARCH_REGION.get() or ("ir-fa" if is_rtl_query(query) else "wt-wt"),
        "--kind", SEARCH_KIND.get(), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
    try:
        output, _ = await asyncio.wait_for(proc.communicate(), timeout=12)
        if proc.returncode:
            raise RuntimeError("ddgs subprocess failed")
        results = json.loads(output)
        record_source("ddgs", "ok" if results else "empty", count=len(results))
        return results
    except Exception as exc:
        if proc.returncode is None:
            proc.kill()
            await proc.communicate()
        record_source("ddgs", "error", error=type(exc).__name__)
        return []


async def run_smart_search(query: str, top_k: int = 5, region: str = "", kind: str = "web", fresh: bool = False) -> dict[str, Any]:
    started = time.monotonic()
    statuses: dict[str, Any] = {}
    SOURCE_STATUS.set(statuses)
    SEARCH_REGION.set(region)
    SEARCH_KIND.set(kind)
    category = "news" if kind == "news" else classify_query(query)
    key = hashlib.sha256(json.dumps([ROUTER_VERSION, query, top_k, region, kind]).encode()).hexdigest()[:24]
    cache = CACHE_DIR / f"search-{key}.json"
    if not fresh and cache.is_file() and time.time() - cache.stat().st_mtime < 300:
        try:
            result = json.loads(cache.read_text())
            result["cache_hit"] = True
            return result
        except (OSError, ValueError):
            pass

    async def tracked(name, call):
        begin = time.monotonic()
        try:
            results = await asyncio.wait_for(call, 16)
            statuses.setdefault(name, {"status": "ok" if results else "empty_or_unparsed"})
            statuses[name].update(count=len(results), elapsed_ms=round((time.monotonic() - begin) * 1000))
            return results
        except Exception as exc:
            record_source(name, "error", error=type(exc).__name__, count=0)
            return []

    async with SearchClient(follow_redirects=False, trust_env=False) as client:
        tasks = [tracked("searxng", search_searxng(client, query)), tracked("exa_mcp", search_exa_mcp(client, query))]
        if TAVILY_API_KEY:
            tasks.append(tracked("tavily", search_tavily(client, query)))
        else:
            record_source("tavily", "disabled", reason="missing_key")
        if category == "academic":
            tasks += [tracked("semantic_scholar", search_semantic_scholar(client, query)), tracked("pubmed", search_pubmed(client, query))]
        lists = await asyncio.gather(*tasks)
        if not lists[0] and GOOGLE_CSE_API_KEY and GOOGLE_CSE_CX:
            lists.append(await tracked("google_cse", search_google_cse(client, query)))
        elif not GOOGLE_CSE_API_KEY or not GOOGLE_CSE_CX:
            record_source("google_cse", "disabled", reason="missing_key")
    if len(rrf_merge(lists)) < 2 or region or kind == "news":
        lists.append(await search_ddgs(query))
    merged = [r for r in rrf_merge(lists) if is_safe_public_url(r.get("url", ""))]
    ranked = rerank_passages(query, merged, top_k=max(top_k * 3, 15))
    final_results, domains = [], {}
    for item in ranked:
        domain = (urlparse(item["url"]).hostname or "").removeprefix("www.")
        if domains.get(domain, 0) >= 2:
            continue
        domains[domain] = domains.get(domain, 0) + 1
        final_results.append(item)
        if len(final_results) >= top_k:
            break
    result = {"router_version": ROUTER_VERSION, "query": query, "category": category,
              "total_candidates": len(merged), "results": final_results, "sources": statuses,
              "cache_hit": False, "elapsed_ms": round((time.monotonic() - started) * 1000)}
    if final_results:
        write_cache(cache, result)
    return result


def looks_like_clean_markdown(text: str, content_type: str) -> bool:
    ct = content_type.lower()
    stripped = text.lstrip()
    if stripped.lower().startswith(("<!doctype html", "<html", "<head", "<body")):
        return False
    if "text/html" in ct:
        return False
    return ("text/markdown" in ct or "text/plain" in ct) and len(stripped) > 64


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
        try:
            cached = json.loads(cache_file.read_text("utf8"))
            cached["markdown"] = cached.get("markdown", "")[:max_chars]
            cached["cache_hit"] = True
            return cached
        except (OSError, ValueError):
            pass

    parsed = urlparse(url)
    base_origin = f"{parsed.scheme}://{parsed.netloc}"

    async with httpx.AsyncClient(follow_redirects=False, trust_env=False, headers={"User-Agent": "OpenMausBot-SmartRead/1.1"}) as client:
        layer1_candidates = []
        if not parsed.query and not parsed.path.endswith(".md") and parsed.path not in ("", "/"):
            layer1_candidates.append(f"{base_origin}{parsed.path.rstrip('/')}.md")
        if parsed.path.endswith(".md"):
            layer1_candidates.append(url)

        for candidate in layer1_candidates:
            if not is_safe_public_url(candidate):
                continue
            try:
                resp = await safe_get(client, candidate, timeout=1.8)
                if resp.status_code == 200 and looks_like_clean_markdown(resp.text, resp.headers.get("content-type", "")):
                    payload = {"url": url, "layer": "native_markdown", "source_url": candidate, "markdown": resp.text[:32000]}
                    write_cache(cache_file, payload)
                    payload["markdown"] = payload["markdown"][:max_chars]
                    return payload
            except Exception:
                pass

        try:
            from trafilatura import extract
            direct = await safe_get(client, url, timeout=12)
            if direct.status_code == 200 and "text/html" in direct.headers.get("content-type", ""):
                text = extract(direct.text, url=url, output_format="markdown", include_links=True)
                if text and len(text.strip()) > 120:
                    payload = {"url": url, "layer": "local_trafilatura", "markdown": text[:32000]}
                    write_cache(cache_file, payload)
                    payload["markdown"] = payload["markdown"][:max_chars]
                    return payload
        except Exception:
            pass

        try:
            jina_resp = await safe_get(
                client,
                "https://r.jina.ai/" + quote(url, safe=":/?#[]@!$&'()*+,;="),
                headers={"Accept": "text/plain"},
                timeout=10.0,
            )
            failed = re.search(r"captcha|access denied|verify you are human|requires? (?:a )?login|sign in to continue", jina_resp.text[:4000], re.I)
            if jina_resp.status_code == 200 and len(jina_resp.text.strip()) > 120 and not failed:
                payload = {"url": url, "layer": "jina_reader", "markdown": jina_resp.text[:32000]}
                write_cache(cache_file, payload)
                payload["markdown"] = payload["markdown"][:max_chars]
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
        try:
            return json.loads(yt_cache.read_text("utf8"))
        except (OSError, ValueError):
            pass

    try:
        from youtube_transcript_api import YouTubeTranscriptApi  # type: ignore

        transcript_list = YouTubeTranscriptApi().list(video_id)
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
                    write_cache(yt_cache, entries)
                    return entries
            except Exception:
                continue
    except Exception as exc:
        record_source("youtube_transcript", "error", error=type(exc).__name__)
    return []


def fetch_ytdlp_subtitles(video_id: str) -> list[dict[str, Any]]:
    with tempfile.TemporaryDirectory(prefix="omb-subtitles-") as tmp:
        try:
            proc = subprocess.run(
                [executable("yt-dlp"), "--ignore-config", "--skip-download", "--no-playlist", "--write-subs", "--write-auto-subs",
                 "--sub-langs", "fa,en", "--sub-format", "json3", "--socket-timeout", "8", "--retries", "0",
                 "-o", str(Path(tmp) / "video.%(ext)s"), f"https://www.youtube.com/watch?v={video_id}"],
                capture_output=True, text=True, timeout=45)
            for file in sorted(Path(tmp).glob("*.json3"), key=lambda p: "fa" not in p.name):
                data = json.loads(file.read_text())
                entries = [{"start": event.get("tStartMs", 0) / 1000,
                            "text": "".join(seg.get("utf8", "") for seg in event.get("segs", []))}
                           for event in data.get("events", []) if event.get("segs")]
                if entries:
                    write_cache(CACHE_DIR / f"yt-{video_id}.json", entries)
                    record_source("youtube_subtitles", "ok", count=len(entries))
                    return entries
            record_source("youtube_subtitles", "unavailable", exit_code=proc.returncode)
        except Exception as exc:
            record_source("youtube_subtitles", "error", error=type(exc).__name__)
    return []


def transcribe_with_groq(video_id: str) -> list[dict[str, Any]]:
    if not GROQ_API_KEY:
        record_source("groq", "disabled", reason="missing_key")
        return []
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    yt_cache = CACHE_DIR / f"yt-{video_id}.json"
    with tempfile.TemporaryDirectory(prefix="omb-yt-") as tmp:
        raw_audio = Path(tmp) / "audio.m4a"
        compact_audio = Path(tmp) / "compact.mp3"
        url = f"https://www.youtube.com/watch?v={video_id}"
        dl = subprocess.run(
            [executable("yt-dlp"), "--ignore-config", "--no-playlist", "-f", "ba[abr<=64]/worstaudio", "-o", str(raw_audio), url],
            capture_output=True,
            text=True,
            timeout=120,
        )
        if dl.returncode != 0 or not raw_audio.exists():
            return []
        ff = subprocess.run(
            [executable("ffmpeg"), "-y", "-i", str(raw_audio), "-ac", "1", "-ar", "16000", "-b:a", "32k", str(compact_audio)],
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
                write_cache(yt_cache, entries)
            return entries
        except Exception:
            return []


def run_yt_inspector(query_or_url: str, question: str, top_k: int = 5) -> dict[str, Any]:
    SOURCE_STATUS.set({})
    vid = extract_video_id(query_or_url)
    video_ids = [vid] if vid else []
    if not video_ids:
        proc = subprocess.run(
            [executable("yt-dlp"), "--ignore-config", "--flat-playlist", "--print", "id", f"ytsearch3:{query_or_url}"],
            capture_output=True,
            text=True,
            timeout=25,
        )
        video_ids = [line.strip() for line in proc.stdout.splitlines() if len(line.strip()) == 11][:3]

    candidates: list[dict[str, Any]] = []
    for v_id in video_ids:
        entries = fetch_yt_transcript(v_id) or fetch_ytdlp_subtitles(v_id) or transcribe_with_groq(v_id)
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
        "router_version": ROUTER_VERSION,
        "target": query_or_url,
        "question": question,
        "matched_segments": ranked,
        "status": "ok" if ranked else "no_transcript",
        "sources": SOURCE_STATUS.get(),
        "warning": None if ranked else "No transcript retrieved; do not infer the video's contents.",
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="OpenMausBot Smart Search, Read & YouTube Router")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_search = sub.add_parser("smart-search")
    p_search.add_argument("query", help="Search query")
    p_search.add_argument("--top-k", type=int, default=5)
    p_search.add_argument("--region", default="", help="DDGS region, e.g. au-en or ir-fa")
    p_search.add_argument("--kind", choices=["web", "news"], default="web")
    p_search.add_argument("--fresh", action="store_true")

    worker = sub.add_parser("_ddgs", help=argparse.SUPPRESS)
    worker.add_argument("query")
    worker.add_argument("--region", default="wt-wt")
    worker.add_argument("--kind", choices=["web", "news"], default="web")

    p_read = sub.add_parser("smart-read")
    p_read.add_argument("url", help="Target URL to extract")
    p_read.add_argument("--max-chars", type=int, default=32000)

    p_yt = sub.add_parser("yt-inspector")
    p_yt.add_argument("target", help="YouTube URL or topic query")
    p_yt.add_argument("--question", default="", help="Specific question to locate in transcript")

    args = parser.parse_args()
    if args.cmd == "_ddgs":
        out = ddgs_worker(args.query, args.region, args.kind)
    elif args.cmd == "smart-search":
        out = asyncio.run(run_smart_search(args.query, top_k=max(1, min(20, args.top_k)), region=args.region, kind=args.kind, fresh=args.fresh))
    elif args.cmd == "smart-read":
        out = asyncio.run(run_smart_read(args.url, max_chars=max(1, min(32000, args.max_chars))))
    else:
        try:
            out = run_yt_inspector(args.target, args.question)
        except Exception as exc:
            out = {"router_version": ROUTER_VERSION, "target": args.target, "matched_segments": [],
                   "status": "error", "error": type(exc).__name__, "warning": "No video content retrieved."}

    print(json.dumps(out, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
