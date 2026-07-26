// katex ships types for the main module but not for the auto-render contrib.
declare module "katex/contrib/auto-render" {
  interface RenderMathOptions {
    delimiters?: { left: string; right: string; display: boolean }[];
    ignoredTags?: string[];
    throwOnError?: boolean;
  }
  export default function renderMathInElement(
    element: HTMLElement,
    options?: RenderMathOptions,
  ): void;
}
