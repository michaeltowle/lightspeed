import renderMathInElement from "katex/contrib/auto-render";

// Model-emitted HTML goes into the DOM, and the model's inputs include
// screenshots -- a prompt-injection surface. Everything outside this allowlist
// is unwrapped (text kept) or dropped entirely, and every attribute is stripped.
// KaTeX builds its own markup locally *after* sanitizing, so its spans and
// styles are never subject to this.
const TMPNAME_ALLOWED_TAGS_01 = new Set([
  "P", "BR", "SPAN", "DIV", "EM", "STRONG", "I", "B", "U",
  "SUP", "SUB", "CODE", "PRE", "SMALL",
  "UL", "OL", "LI",
  "TABLE", "THEAD", "TBODY", "TR", "TD", "TH",
]);

const TMPNAME_DROPPED_TAGS_01 = new Set([
  "SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "LINK", "META",
  "FORM", "INPUT", "BUTTON", "TEXTAREA", "SELECT", "SVG", "MATH",
]);

function scrub(node: Element): void {
  for (const child of Array.from(node.children)) scrub(child);

  if (TMPNAME_DROPPED_TAGS_01.has(node.tagName)) {
    node.remove();
    return;
  }

  for (const attr of Array.from(node.attributes)) {
    node.removeAttribute(attr.name);
  }

  if (!TMPNAME_ALLOWED_TAGS_01.has(node.tagName)) {
    // Unwrap: keep the text, discard the element.
    node.replaceWith(...Array.from(node.childNodes));
  }
}

/**
 * Parse model HTML inertly and strip it down to the allowlist. A <template>'s
 * content is inert, so nothing executes and no image/onerror fires while we work.
 */
export function tmpnameSanitizeModelHtml01(html: string): DocumentFragment {
  const template = document.createElement("template");
  template.innerHTML = html;
  for (const child of Array.from(template.content.children)) scrub(child);
  return template.content;
}

/** Insert sanitized model HTML, then let KaTeX render any math inside it. */
export function tmpnameRenderMathHtml01(target: HTMLElement, html: string): void {
  target.replaceChildren(tmpnameSanitizeModelHtml01(html));
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
