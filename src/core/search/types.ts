export interface SearchResult {
  url: string;
  title: string;
  snippet: string;
  engine: string;
  content?: string;
  error?: string;
}

export interface SearchProvider {
  name: string;
  search(query: string, limit: number): Promise<SearchResult[]>;
}
