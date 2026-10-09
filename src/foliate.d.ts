declare module "../../../vendor/foliate-js/view.js" {
  export function makeBook(file: string): Promise<{
    transformTarget?: EventTarget;
    toc?: { label: string; href: string; subitems?: unknown[] }[];
    metadata?: { title?: unknown; author?: unknown };
  }>;
}
