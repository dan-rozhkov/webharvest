/** Shared by both search providers: strips HTML markup (e.g. Brave's/SearXNG's
 *  `<span class="highlight">` around matched terms) out of titles and
 *  snippets before they land in the agent's context, without mangling
 *  ordinary `<`/`>` comparisons in prose or code that never formed a real tag.
 *
 *  The main pattern requires a lowercase letter immediately after `<` (or
 *  `</`) before it will treat the span as a tag at all — real HTML elements
 *  in these snippets (`<span>`, `<b>`, `<em>`, `<mark>`, ...) are always
 *  lowercase, while a bare `<` in prose is normally followed by a space or
 *  digit ("3 < 5", "a < b") and a generic type parameter is conventionally
 *  uppercase ("Vec<T>"). Without that guard the old pattern matched *any*
 *  `<...>` span — including "3 < 5 and 7 > 2" — and silently ate the text
 *  between them. The two patterns below are kept in lockstep (same
 *  lowercase-letter requirement) so a future edit to one can't regress the
 *  other back into stripping prose. */
export const stripTags = (s: string): string =>
  s
    .replace(/<\/?[a-z](?:[^>"']|"[^"]*"|'[^']*')*>/g, '') // complete tags with quoted attributes
    .replace(/<\/?[a-z][^>]*$/, '') // truncated tag start at end (< followed by letter or </)
    .trim();
