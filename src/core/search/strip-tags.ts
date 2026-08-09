/** Shared by both search providers: strips HTML markup (e.g. Brave's/SearXNG's
 *  `<span class="highlight">` around matched terms) out of titles and
 *  snippets before they land in the agent's context, without mangling
 *  ordinary `<`/`>` comparisons in prose or code that never formed a real tag.
 *
 *  The name group requires a letter immediately after `<` (or `</`) before
 *  it will treat the span as a tag at all — a bare `<` in prose is normally
 *  followed by a space or digit ("3 < 5", "a < b", "a <3 heart") and never
 *  matches. Tag names are matched case-insensitively (HTML tag names are
 *  case-insensitive, so `<span>`, `<SPAN>`, and `<Span>` are all real tags),
 *  *except* a single uppercase letter with nothing else in the name, which
 *  is left alone — that's the shape of a generic type parameter ("Vec<T>"),
 *  not of any real HTML element, and single-letter real tags are always
 *  written lowercase ("<b>", "<a>", "<i>") by convention. Multi-character
 *  names are matched in any case since a generic parameter is never more
 *  than one letter. Without the name guard entirely, the old pattern
 *  matched *any* `<...>` span — including "3 < 5 and 7 > 2" — and silently
 *  ate the text between them. The two patterns below are kept in lockstep
 *  (same name rule) so a future edit to one can't regress the other back
 *  into stripping prose. */
const TAG_NAME = '(?:[a-z][a-zA-Z0-9]*|[A-Z][a-zA-Z0-9]+)';
export const stripTags = (s: string): string =>
  s
    .replace(new RegExp(`<\\/?${TAG_NAME}(?:[^>"']|"[^"]*"|'[^']*')*>`, 'g'), '') // complete tags with quoted attributes
    .replace(new RegExp(`<\\/?${TAG_NAME}[^>]*$`), '') // truncated tag start at end (< followed by tag name or </)
    .trim();
