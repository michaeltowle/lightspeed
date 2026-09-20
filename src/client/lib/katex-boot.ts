import renderMathInElement from "katex/contrib/auto-render";

// Model-emitted HTML goes into the DOM, and the model's inputs include
// screenshots -- a prompt-injection surface. Everything outside this allowlist
// is unwrapped (text kept) or dropped entirely, and every attribute is stripped.
// KaTeX builds its own markup locally *after* sanitizing, so its spans and
// styles are never subject to this.
const ALLOWED_TAGS = new Set([
  "P", "BR", "SPAN", "DIV", "EM", "STRONG", "I", "B", "U",
  "SUP", "SUB", "CODE", "PRE", "SMALL",
  "UL", "OL", "LI",
  "TABLE", "THEAD", "TBODY", "TR", "TD", "TH",
]);

const DROPPED_TAGS = new Set([
  "SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "LINK", "META",
  "FORM", "INPUT", "BUTTON", "TEXTAREA", "SELECT", "SVG", "MATH",
]);

function scrub(node: Element): void {
  for (const child of Array.from(node.children)) scrub(child);

  if (DROPPED_TAGS.has(node.tagName)) {
    node.remove();
    return;
  }

  for (const attr of Array.from(node.attributes)) {
    node.removeAttribute(attr.name);
  }

  if (!ALLOWED_TAGS.has(node.tagName)) {
    // Unwrap: keep the text, discard the element.
    node.replaceWith(...Array.from(node.childNodes));
  }
}

// Longest first: "$$" has to be tried before "$" or every display span is read
// as two empty inline ones.
const MATH_SPANS = [
  { open: "$$", close: "$$" },
  { open: "\\[", close: "\\]" },
  { open: "\\(", close: "\\)" },
  { open: "$", close: "$" },
];

/**
 * Escape raw angle brackets inside math, before any HTML parser sees them.
 *
 * The model is told to emit HTML with LaTeX inside $...$, and inside math a
 * `<` is simply less-than. To an HTML parser it opens a tag: `$P(|X|<t)=0$`
 * parses as the text `$P(|X|` followed by a bogus `<t)...>` element, and
 * everything up to the next `>` is swallowed. Seen live on a conditional
 * probability -- four of one problem's six result cells lost their contents,
 * and the one with a `cases` block came back as `P(|X|0\end{cases}` once the
 * parser had eaten the middle.
 *
 * Only raw brackets are touched, and only between delimiters. One the model
 * already wrote as `&lt;` holds no `<` to find, so both spellings reach KaTeX
 * as the same character. `&` is deliberately left alone: escaping it would
 * turn an already-escaped `&lt;` into a visible one.
 */
export function escapeAnglesInsideMath(html: string): string {
  let out = "";
  let at = 0;

  while (at < html.length) {
    const span = MATH_SPANS.find((candidate) => html.startsWith(candidate.open, at));
    const from = span ? at + span.open.length : -1;
    const closes = span ? html.indexOf(span.close, from) : -1;

    // An unpaired delimiter is not math -- a lone dollar sign is a dollar sign.
    if (!span || closes === -1) {
      out += html[at];
      at += 1;
      continue;
    }

    out +=
      span.open +
      html.slice(from, closes).replace(/</g, "&lt;").replace(/>/g, "&gt;") +
      span.close;
    at = closes + span.close.length;
  }

  return out;
}

/**
 * Parse model HTML inertly and strip it down to the allowlist. A <template>'s
 * content is inert, so nothing executes and no image/onerror fires while we work.
 */
export function sanitizeModelHtml(html: string): DocumentFragment {
  const template = document.createElement("template");
  template.innerHTML = escapeAnglesInsideMath(html);
  for (const child of Array.from(template.content.children)) scrub(child);
  return template.content;
}

/** Insert sanitized model HTML, then let KaTeX render any math inside it. */
export function renderMathHtml(target: HTMLElement, html: string): void {
  target.replaceChildren(sanitizeModelHtml(html));
  try {
    renderMathInElement(target, {
      delimiters: [
        { left: "$$", right: "$$", display: true },
        { left: "$", right: "$", display: false },
        { left: "\\(", right: "\\)", display: false },
        { left: "\\[", right: "\\]", display: true },
      ],
      // A malformed expression renders as red source text instead of throwing,
      // so one bad problem can't blank the whole view.
      throwOnError: false,
    });
  } catch {
    // Even with throwOnError off, never let math rendering take down the view.
  }
}
