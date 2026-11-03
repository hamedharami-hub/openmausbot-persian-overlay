type Option = { id: string; label?: string; custom?: boolean };

function identity(id: string) {
  const parts = id.toLowerCase().split("/");
  const slug = parts.pop() ?? id;
  const route = parts.join("/");
  const family = /(?:^|[-_])(gpt|claude|gemini|grok|deepseek|qwen|llama|mistral|kimi|glm|gemma|phi|command|nova|seed|solar|nemotron)/u.exec(slug)?.[1]
    ?? slug;
  return { slug, group: `${route}/${family}`, family };
}

function versions(slug: string): number[] {
  const match = /(?:^|[-_v])(\d+(?:\.\d+)*)(?=[-_:.]|$)/u.exec(slug);
  return match ? match[1].split(".").map(Number) : [0];
}

function compareVersion(a: string, b: string): number {
  const av = versions(a), bv = versions(b);
  if (a.startsWith("grok") && b.startsWith("grok") && av[0] === bv[0]) {
    const decimal = (id: string) => Number(/\d+(?:\.\d+)?/u.exec(id)?.[0] ?? 0);
    if (decimal(a) !== decimal(b)) return decimal(b) - decimal(a);
  }
  for (let i = 0; i < Math.max(av.length, bv.length); i++) {
    const difference = (bv[i] ?? 0) - (av[i] ?? 0);
    if (difference) return difference;
  }
  return a.localeCompare(b);
}

function branch(slug: string, family: string): string {
  if (family === "gpt") return /(?:^|-)(luna|terra|astra|sol)(?:-|$)/u.exec(slug)?.[1]
    ?? (/mini/u.test(slug) ? "mini" : /nano/u.test(slug) ? "nano" : "main");
  if (family === "claude") return /opus|sonnet|haiku/u.exec(slug)?.[0] ?? "main";
  if (family === "gemini") return /flash-lite|flash|pro/u.exec(slug)?.[0] ?? "main";
  if (family === "deepseek") return /flash|pro|reasoner|chat/u.exec(slug)?.[0] ?? "main";
  return /(?:^|-)(coder|coding|thinking|reasoning|instruct|mini|small|medium|large|fast|pro|flash)(?:-|$)/u.exec(slug)?.[1] ?? "main";
}

/** Presentation only: native IDs and saved/starred selections remain unchanged. */
export function curatedModels<T extends Option>(options: readonly T[], retain: ReadonlySet<string> = new Set()): T[] {
  const unique = [...new Map(options.map((option) => [option.id, option])).values()];
  const groups = new Map<string, T[]>();
  for (const option of unique) {
    const { slug, group } = identity(option.id);
    if (/(?:^|[-_/:(])free(?:$|[)\s])/iu.test(`${option.id} ${option.label ?? ""}`)) continue;
    if (/:batch\b|:extended\b|\bpreview\b|\bexperimental\b/u.test(slug)) continue;
    if (option.id.includes("~") || /(?:^|-)latest$/u.test(slug)) continue;
    if (unique.length > 30 && !/gpt|claude|gemini|grok|deepseek|qwen|llama|mistral|kimi|glm|gemma|phi|command|nova|seed|solar|nemotron/u.test(identity(option.id).family)) continue;
    const rows = groups.get(group) ?? [];
    rows.push(option); groups.set(group, rows);
  }
  const keep = new Set<string>();
  for (const rows of groups.values()) {
    const canonical = rows.filter((row) => {
      const root = row.id.replace(/[-_]\d{4,8}(?=[:_-]|$)/gu, "").replace(/-(?:fast|ultrafast|pro)$/u, "");
      return root === row.id || !rows.some((candidate) => candidate.id === root);
    });
    const namedGpt = canonical.some((row) => identity(row.id).family === "gpt" && /(?:^|-)(luna|terra|astra|sol)(?:-|$)/u.test(identity(row.id).slug));
    const candidates = namedGpt ? canonical.filter((row) => /(?:^|-)(luna|terra|astra|sol)(?:-|$)/u.test(identity(row.id).slug)) : canonical;
    const ordered = candidates.sort((a, b) => compareVersion(identity(a.id).slug, identity(b.id).slug));
    const major = Math.max(...ordered.map((row) => versions(identity(row.id).slug)[0]));
    const branches = new Set<string>();
    for (const row of ordered) {
      const { slug, family } = identity(row.id);
      if (family === "deepseek" && versions(slug)[0] < major) continue;
      const key = branch(slug, family);
      if (branches.has(key)) continue;
      branches.add(key); keep.add(row.id);
      if (branches.size === 4) break;
    }
    if (!branches.size && rows[0]) keep.add(rows[0].id);
  }
  return unique.filter((option) => retain.has(option.id) || keep.has(option.id)
    || /(?:^|[-_/:(])free(?:$|[)\s])/iu.test(`${option.id} ${option.label ?? ""}`));
}
