/** Shared by both search providers: strips HTML markup (e.g. Brave's/SearXNG's
 *  `<span class="highlight">` around matched terms) out of titles and
 *  snippets before they land in the agent's context, without mangling
 *  ordinary `<`/`>` comparisons in prose or code that never formed a real tag. */
export const stripTags = (s: string): string =>
  s
    .replace(/<(?:[^>"']|"[^"]*"|'[^']*')*>/g, '') // complete tags with quoted attributes
    .replace(/<\/?[a-zA-Z][^>]*$/, '') // truncated tag start at end (< followed by letter or </)
    .trim();
