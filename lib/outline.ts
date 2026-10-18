/**
 * Language-agnostic outline: shallow lines (imports, declarations) plus every line near a request term. Deeper lines are dropped.
 * Prototype for the skeleton-vs-full question; works on any indented text, no parser.
 * ponytail: indentation stands in for structure and suffix stripping for stemming. A parser (tree-sitter) if this proves too crude.
 */

const STOP = new Set(("this that with from when what which where should would could because there their these those into have does " +
  "file files code about after before need needs fails failing work works make makes using used test tests").split(" "));

/** Lowercase terms from the request: words of 4+ letters, stopwords dropped, crude suffixes stripped. */
export function requestTerms(request: string): string[] {
  const words = request.toLowerCase().match(/[a-z_][a-z0-9_]{3,}/g) ?? [];
  return [...new Set(words.filter((w) => !STOP.has(w)).map((w) => w.replace(/(ing|ed|es|s)$/, "")).filter((w) => w.length >= 4))];
}

const indentOf = (line: string) => (line.match(/^[ \t]*/)![0].replace(/\t/g, "    ")).length;

/** Lines at indent depth <= maxDepth, plus `context` lines around any line containing a term. Gaps become one `…` line. */
export function outline(content: string, terms: string[], { maxDepth = 0, context = 3 } = {}): string {
  const lines = content.split("\n");
  // Block-comment continuations (" * text") would read as a 1-space indent unit, and belong to the line they document anyway.
  const isDocLine = (l: string) => /^\s*\*/.test(l);
  const indents = lines.filter((l) => l.trim() && !isDocLine(l)).map(indentOf);
  const unit = Math.min(...indents.filter((n) => n > 0)) || 4;
  const keep = lines.map((l) => l.trim() !== "" && (isDocLine(l) ? indentOf(l) <= unit * maxDepth + 1 : indentOf(l) <= unit * maxDepth));
  lines.forEach((l, i) => {
    const lower = l.toLowerCase();
    if (!terms.some((t) => lower.includes(t))) return;
    for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) keep[j] = true;
  });
  const out: string[] = [];
  lines.forEach((l, i) => {
    if (keep[i]) out.push(l);
    else if (out.at(-1) !== "…") out.push("…");
  });
  return out.join("\n");
}
