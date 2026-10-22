// Vite features used by tests (raw imports and globbing of eval fixtures).
declare module '*?raw' {
  const content: string;
  export default content;
}

interface ImportMeta {
  glob(
    pattern: string,
    options: { query?: string; import?: string; eager: true },
  ): Record<string, unknown>;
}
