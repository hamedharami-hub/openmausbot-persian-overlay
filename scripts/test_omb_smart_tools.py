import asyncio
import importlib.util
import json
from pathlib import Path
import socket
import tempfile
import unittest
from unittest.mock import patch, AsyncMock

import httpx

spec = importlib.util.spec_from_file_location("router", Path(__file__).with_name("omb-smart-tools.py"))
router = importlib.util.module_from_spec(spec)
spec.loader.exec_module(router)


def public_dns(host, *args, **kwargs):
    address = "127.0.0.1" if host in ("localhost", "127.0.0.1") else "93.184.216.34"
    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (address, 443))]


class RouterChecks(unittest.IsolatedAsyncioTestCase):
    async def test_private_and_credentials_rejected(self):
        with patch.object(socket, "getaddrinfo", side_effect=public_dns):
            for url in ["http://localhost/x", "http://127.0.0.1/x", "https://user:secret@example.com/", "http://example.com:8770/"]:
                self.assertFalse(router.is_safe_public_url(url))
            self.assertTrue(router.is_safe_public_url("https://example.com/"))

    async def test_dns_pinning_and_redirect_rejection(self):
        requests = []
        def handler(req):
            requests.append(req)
            return httpx.Response(302, headers={"location": "http://127.0.0.1/api/bots"})
        with patch.object(socket, "getaddrinfo", side_effect=public_dns):
            async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
                with self.assertRaises(ValueError):
                    await router.safe_get(client, "https://example.com/", timeout=1)
        self.assertEqual(len(requests), 1)
        self.assertEqual(requests[0].url.host, "93.184.216.34")
        self.assertEqual(requests[0].headers["host"], "example.com")
        self.assertEqual(requests[0].extensions["sni_hostname"], "example.com")

    async def test_reader_size_limit(self):
        with patch.object(socket, "getaddrinfo", side_effect=public_dns):
            async with httpx.AsyncClient(transport=httpx.MockTransport(lambda req: httpx.Response(200, content=b"x" * (4 * 1024 * 1024 + 1)))) as client:
                with self.assertRaises(ValueError):
                    await router.safe_get(client, "https://example.com/", timeout=1)

    async def test_compressed_reader_response(self):
        import gzip
        body = b"Some readable text " * 50
        def handler(req):
            return httpx.Response(200, headers={"content-encoding": "gzip", "content-type": "text/plain"}, content=gzip.compress(body))
        with patch.object(socket, "getaddrinfo", side_effect=public_dns):
            async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
                result = await router.safe_get(client, "https://example.com/", timeout=1)
                self.assertEqual(result.content, body)

    async def test_reader_never_substitutes_llms(self):
        calls = []
        async def get(client, url, **kwargs):
            calls.append(url)
            return httpx.Response(200, headers={"content-type": "text/markdown"}, text="Page content " * 30)
        with tempfile.TemporaryDirectory() as tmp, patch.object(router, "CACHE_DIR", Path(tmp)), patch.object(router, "is_safe_public_url", return_value=True), patch.object(router, "safe_get", side_effect=get):
            result = await router.run_smart_read("https://example.com/article", 40)
            self.assertEqual(result["layer"], "native_markdown")
            second = await router.run_smart_read("https://example.com/article", 300)
            self.assertGreater(len(second["markdown"]), 40)
            self.assertTrue(second["cache_hit"])
        self.assertFalse(any("llms.txt" in url for url in calls))

    async def test_search_fallback_diversity_cache(self):
        rows = [{"title": str(i), "url": f"https://site{i // 3}.org/{i}", "snippet": "hello"} for i in range(8)]
        with tempfile.TemporaryDirectory() as tmp, patch.object(router, "CACHE_DIR", Path(tmp)), patch.object(router, "search_searxng", new=AsyncMock(return_value=[])), patch.object(router, "search_exa_mcp", new=AsyncMock(return_value=[])), patch.object(router, "search_ddgs", new=AsyncMock(return_value=rows)) as ddgs, patch.object(router, "is_safe_public_url", return_value=True), patch.object(router, "rerank_passages", side_effect=lambda q, rows, top_k: rows):
            result = await router.run_smart_search("hello", top_k=5, fresh=True)
            self.assertEqual(ddgs.await_count, 1)
            self.assertEqual(len(result["results"]), 5)
            self.assertLessEqual(sum("site0.org" in x["url"] for x in result["results"]), 2)
            cached = await router.run_smart_search("hello", top_k=5)
            self.assertTrue(cached["cache_hit"])
            self.assertEqual(ddgs.await_count, 1)

    async def test_search_client_rejects_internal_endpoint(self):
        with patch.object(socket, "getaddrinfo", side_effect=public_dns):
            async with router.SearchClient() as client:
                with self.assertRaises(ValueError):
                    await client.get("http://127.0.0.1:8770/api/bots")

    async def test_rrf_deduplication(self):
        lists = [[{"url": "https://example.com/a?utm_source=x", "title": "a"}], [{"url": "https://example.com/a", "title": "a"}]]
        self.assertEqual(len(router.rrf_merge(lists)), 1)

    async def test_exa_parser_preserves_multiple_results(self):
        text = "Title: First\nURL: https://one.org/\nPublished: N/A\nAuthor: N/A\nHighlights:\nfirst text\nTitle: Second\nURL: https://two.org/\nPublished: N/A\nAuthor: N/A\nText:\nsecond text"
        response = httpx.Response(200, json={"result": {"content": [{"type": "text", "text": text}]}})
        client = unittest.mock.Mock()
        client.post = AsyncMock(return_value=response)
        results = await router.search_exa_mcp(client, "query")
        self.assertEqual(len(results), 2)
        self.assertEqual(results[0]["title"], "First")
        self.assertEqual(results[1]["title"], "Second")

    async def test_transcript_api_matches_installed_version(self):
        from youtube_transcript_api import YouTubeTranscriptApi
        self.assertTrue(callable(getattr(YouTubeTranscriptApi(), "list", None)))


if __name__ == "__main__":
    unittest.main()
