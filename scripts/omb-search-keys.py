#!/usr/bin/env python3
import argparse
import getpass
import os
from pathlib import Path
import re
import tempfile

parser = argparse.ArgumentParser(description="Store an OMB search key without printing it")
parser.add_argument("name", choices=["TAVILY_API_KEY", "GROQ_API_KEY", "SEMANTIC_SCHOLAR_API_KEY", "GOOGLE_CSE_API_KEY", "GOOGLE_CSE_CX"])
args = parser.parse_args()
value = getpass.getpass(f"{args.name} (hidden): ").strip()
if not value or not re.fullmatch(r"[A-Za-z0-9_.:-]+", value):
    raise SystemExit("Empty or invalid value; nothing changed")
root = Path.home() / ".config/omb-search"
root.mkdir(mode=0o700, parents=True, exist_ok=True)
path = root / ".env"
lines = path.read_text().splitlines() if path.is_file() else []
lines = [line for line in lines if not line.startswith(args.name + "=")]
lines.append(args.name + "=" + value)
fd, tmp = tempfile.mkstemp(dir=root, prefix=".keys-")
try:
    with os.fdopen(fd, "w") as stream:
        stream.write("\n".join(lines) + "\n")
    os.replace(tmp, path)
finally:
    if os.path.exists(tmp):
        os.unlink(tmp)
print(f"Saved {args.name}; key was not displayed. New tool calls load it automatically.")
