export interface SearchResult {
  url: string;
  title: string;
  snippet: string;
  engine: string;
  content?: string;
  /** Set only when `content` was cut short (fetchContent embeds each page's
   *  markdown under a fixed character budget). Mirrors formatScrape's own
   *  truncation notice so the agent can't mistake a cut-off page for the
   *  whole thing. */
  truncated?: boolean;
  remaining?: number;
  error?: string;
}

export interface SearchProvider {
  name: string;
  search(query: string, limit: number): Promise<SearchResult[]>;
}
