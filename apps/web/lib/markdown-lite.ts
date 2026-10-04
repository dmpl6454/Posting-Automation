/**
 * markdown-lite — a small, SAFE Markdown → HTML converter for WordPress
 * articles (2026-10-04).
 *
 * ⚠️ TWO IDENTICAL COPIES exist on purpose: this canonical file in
 * @postautomation/social (the publish worker renders the article body with it)
 * and apps/web/lib/markdown-lite.ts (Compose's article preview renders the SAME
 * HTML, so what the author sees is what the site receives). The web bundle must
 * not import a server package for one function. A parity test in packages/api
 * asserts the two files are byte-identical — edit both or that test fails.
 *
 * Security contract: the input is treated as TEXT, never as HTML. Every `<`,
 * `>`, `&` and `"` is escaped BEFORE any markup is recognised, so an author
 * cannot smuggle a tag, an attribute or a script through the body — the worker
 * posts the result to the site with an editor-level credential, and the preview
 * injects it with dangerouslySetInnerHTML. Links and images accept http(s) (and
 * mailto for links) only; anything else renders as plain text.
 *
 * Supported subset (deterministic, line-based):
 *   # … ######   headings          ---  / ***   horizontal rule
 *   > quote      blockquote        - / * / +    bullet list     1. ordered list
 *   ```fence```  code block        blank line   paragraph break
 *   **bold** __bold__ *em* _em_ `code` ~~del~~ [text](url) ![alt](url)
 * A single newline inside a paragraph becomes <br>, which is how most people
 * expect a textarea to behave.
 */

const URL_LINK_RE = /^(https?:\/\/|mailto:)/i;
const URL_IMAGE_RE = /^https?:\/\//i;

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Inline markup on an ALREADY-ESCAPED line. */
export function renderInline(escaped: string): string {
  // Spans that must not be touched by later passes: inline code, and an image
  // whose URL was refused (otherwise the link pass would re-read it as a link).
  const kept: string[] = [];
  const keep = (html: string) => {
    kept.push(html);
    return `\u0000${kept.length - 1}\u0000`;
  };
  let s = escaped.replace(/`([^`\n]+)`/g, (_m, code: string) => keep(`<code>${code}</code>`));
  // Images before links (same bracket syntax with a leading "!").
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt: string, url: string) =>
    URL_IMAGE_RE.test(url) ? `<img src="${url}" alt="${alt}">` : keep(m),
  );
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text: string, url: string) =>
    URL_LINK_RE.test(url) ? `<a href="${url}">${text}</a>` : m,
  );
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^_\n]+)__/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, "$1<em>$2</em>");
  s = s.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => kept[Number(i)] ?? "");
}

const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR_RE = /^(?:-{3,}|\*{3,}|_{3,})\s*$/;
const UL_RE = /^[-*+]\s+(.*)$/;
const OL_RE = /^\d+[.)]\s+(.*)$/;
const QUOTE_RE = /^>\s?(.*)$/;
const FENCE_RE = /^```/;

/**
 * Convert Markdown text to HTML. Output is a sequence of block elements joined
 * by newlines; an empty/whitespace input yields "".
 */
export function markdownToHtml(markdown: string): string {
  const lines = (markdown ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;

  const flushParagraph = (buf: string[]) => {
    if (buf.length === 0) return;
    out.push(`<p>${buf.map((l) => renderInline(escapeHtml(l))).join("<br>")}</p>`);
    buf.length = 0;
  };

  let para: string[] = [];
  while (i < lines.length) {
    const raw = lines[i] ?? "";
    const line = raw.replace(/\s+$/, "");

    if (FENCE_RE.test(line)) {
      flushParagraph(para);
      const code: string[] = [];
      i++;
      while (i < lines.length && !FENCE_RE.test(lines[i] ?? "")) {
        code.push(lines[i] ?? "");
        i++;
      }
      i++; // closing fence (or EOF)
      out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }

    if (line.trim() === "") {
      flushParagraph(para);
      i++;
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      flushParagraph(para);
      const level = heading[1]!.length;
      out.push(`<h${level}>${renderInline(escapeHtml(heading[2] ?? ""))}</h${level}>`);
      i++;
      continue;
    }

    if (HR_RE.test(line)) {
      flushParagraph(para);
      out.push("<hr>");
      i++;
      continue;
    }

    if (QUOTE_RE.test(line)) {
      flushParagraph(para);
      const quoted: string[] = [];
      while (i < lines.length && QUOTE_RE.test(lines[i] ?? "")) {
        quoted.push(QUOTE_RE.exec(lines[i] ?? "")![1] ?? "");
        i++;
      }
      out.push(`<blockquote>${markdownToHtml(quoted.join("\n"))}</blockquote>`);
      continue;
    }

    if (UL_RE.test(line) || OL_RE.test(line)) {
      flushParagraph(para);
      const ordered = OL_RE.test(line);
      const re = ordered ? OL_RE : UL_RE;
      const items: string[] = [];
      while (i < lines.length && re.test((lines[i] ?? "").replace(/\s+$/, ""))) {
        items.push(re.exec((lines[i] ?? "").replace(/\s+$/, ""))![1] ?? "");
        i++;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>${items.map((t) => `<li>${renderInline(escapeHtml(t))}</li>`).join("")}</${tag}>`);
      continue;
    }

    para.push(line);
    i++;
  }
  flushParagraph(para);
  return out.join("\n");
}

/** Plain-text excerpt helper: strips markup, collapses whitespace, word-aware cut. */
export function markdownToExcerpt(markdown: string, max = 160): string {
  const text = (markdown ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/^[-*+]\s+/gm, "")
    .replace(/^\d+[.)]\s+/gm, "")
    .replace(/[*_~`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:.!?-]+$/, "")}…`;
}
