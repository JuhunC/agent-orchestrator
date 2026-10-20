/**
 * Returns the lowercased logins @-mentioned in a GitHub markdown body, ignoring
 * code, quoted replies, HTML comments, e-mail addresses and team mentions.
 */
export function extractMentions(markdown: string | null | undefined): string[] {
  if (!markdown) return [];
  const text = markdown
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/~~~[\s\S]*?(~~~|$)/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .split("\n")
    .filter((line) => !/^\s*>/.test(line))
    .join("\n");

  const found = new Set<string>();
  const pattern = /(^|[^\w@/.`-])@([a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38})(?![\w-]*\/[\w-])/gi;
  for (const match of text.matchAll(pattern)) found.add(match[2]!.toLowerCase());
  return [...found];
}
