import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { randomUUID } from "node:crypto";

import { DATA_DIR } from "./config.ts";
import type { TurnImageInput } from "./contracts.ts";

/** How many pages of one PDF become native image input. Four keeps a plan readable without flooding the turn. */
export const PDF_RENDER_MAX_PAGES = 4;
/** At this scale an A4 page lands near 900x1300 pixels: enough to read a dimension, small enough to send. */
const PDF_RENDER_DPI = 110;
/** One rendered page larger than this is dropped rather than sent. */
const PDF_RENDER_MAX_BYTES = 4 * 1024 * 1024;
/** Rendered pages are scratch: they are removed once they are older than this. */
const PDF_RENDER_TTL_MS = 2 * 60 * 60 * 1000;
const PDF_RENDER_TIMEOUT_MS = 30_000;

const RENDER_ROOT = join(DATA_DIR, "pdf-renders");

function findOnPath(tool: string): string | null {
  const path = process.env.PATH ?? "";
  for (const folder of path.split(delimiter)) {
    if (!folder) continue;
    const candidate = join(folder, tool);
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

/** The rendered pages of a document the app owns are scratch, not attachments: they expire. */
function sweepExpiredRenders(): void {
  let folders: string[];
  try {
    folders = readdirSync(RENDER_ROOT);
  } catch {
    return;
  }
  const now = Date.now();
  for (const folder of folders) {
    const path = join(RENDER_ROOT, folder);
    try {
      if (now - statSync(path).mtimeMs > PDF_RENDER_TTL_MS) rmSync(path, { recursive: true, force: true });
    } catch {
      continue;
    }
  }
}

/**
 * The pages of a PDF as native image input, so a model that understands pictures reads the
 * document itself instead of a text extract of it. An empty result is normal: poppler may be
 * absent, the file may not be a PDF, or every page may be too large. The caller keeps the
 * document's path either way, so a bot can still read it with its own tools.
 */
export function renderPdfPages(pdfPath: string, maxPages: number = PDF_RENDER_MAX_PAGES): TurnImageInput[] {
  const tool = findOnPath("pdftoppm");
  if (!tool) return [];

  const folder = join(RENDER_ROOT, randomUUID());
  try {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    execFileSync(tool, ["-r", String(PDF_RENDER_DPI), "-png", "-f", "1", "-l", String(maxPages), pdfPath, join(folder, "page")], {
      timeout: PDF_RENDER_TIMEOUT_MS,
      stdio: "ignore",
    });
  } catch {
    rmSync(folder, { recursive: true, force: true });
    return [];
  }

  let names: string[];
  try {
    names = readdirSync(folder).filter((name) => name.endsWith(".png")).sort();
  } catch {
    return [];
  }

  const images: TurnImageInput[] = [];
  for (const name of names.slice(0, maxPages)) {
    const path = join(folder, name);
    try {
      const bytes = statSync(path).size;
      if (bytes <= 0 || bytes > PDF_RENDER_MAX_BYTES) continue;
      images.push({ path, mime: "image/png", bytes });
    } catch {
      continue;
    }
  }
  if (images.length === 0) rmSync(folder, { recursive: true, force: true });
  else sweepExpiredRenders();
  return images;
}
