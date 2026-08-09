/** Shared by both search providers: strips HTML markup (e.g. Brave's/SearXNG's
 *  `<span class="highlight">` around matched terms) out of titles and
 *  snippets before they land in the agent's context, without mangling
 *  ordinary `<`/`>` comparisons in prose or code that never formed a real tag.
 *
 *  This does not attempt to be a general HTML stripper. There is no shape
 *  of a tag name that reliably distinguishes a real element from a generic
 *  type parameter — `<Vec>`, `<List>`, `<HashMap>` are exactly as
 *  "tag-shaped" as `<span>` or `<Mark>`. Trying to tell them apart by name
 *  length or capitalization (as an earlier version of this function did,
 *  on the theory that "a generic parameter is never more than one letter")
 *  is a guess, and it guesses wrong: it silently ate real content such as
 *  `Vec<Type> parameter` -> `Vec parameter` and `Result<T, Error>` ->
 *  `Result`.
 *
 *  Instead this matches a fixed, known set of HTML element names — the
 *  only markup Brave and SearXNG actually emit in titles/snippets is
 *  highlight formatting (`<span>`, `<mark>`, `<b>`, etc.), never arbitrary
 *  elements. Matched case-insensitively, since HTML tag names are
 *  case-insensitive (`<span>`, `<SPAN>`, `<Span>` are all the same tag).
 *  Anything not in KNOWN_TAGS is left untouched, including generic type
 *  parameters of any length (`Vec<T>`, `List<int>`, `Result<T, Error>`,
 *  `HashMap<K, V>`) and ordinary `<`/`>` comparisons in prose or code
 *  ("3 < 5 and 7 > 2", "if (a < b && c > d)").
 *
 *  Residual limitation: a snippet that genuinely contains the literal text
 *  `<span>` as prose (not markup) will still have it stripped, same as
 *  before. That's an acceptable trade for this input — search snippets do
 *  not carry raw HTML as prose — but it should be written down rather than
 *  rediscovered by surprise.
 *
 *  The two patterns below (complete tag with quoted attributes, and
 *  truncated tag at end of string) are kept in lockstep on the same known
 *  tag set so a future edit to one can't regress the other. A word-boundary
 *  lookahead on the complete-tag pattern stops "spanish" from matching as
 *  "span" plus bogus attribute text. The truncated-tag pattern additionally
 *  accepts any *prefix* of a known name ("sp" as a cut-off "span"), since a
 *  truncated tag by definition may not have its full name yet. */
const KNOWN_TAGS = [
  'span', 'strong', 'b', 'em', 'i', 'mark', 'u', 'small', 'code', 'a',
  'p', 'div', 'br', 'wbr', 'sup', 'sub', 'del', 'ins', 'font',
];

const prefixesOf = (name: string): string[] =>
  Array.from({ length: name.length }, (_, i) => name.slice(0, i + 1));

const TAG_NAME = `(?:${KNOWN_TAGS.join('|')})(?![a-zA-Z0-9])`;
const TAG_NAME_PREFIX = `(?:${Array.from(new Set(KNOWN_TAGS.flatMap(prefixesOf)))
  .sort((a, b) => b.length - a.length)
  .join('|')})`;

export const stripTags = (s: string): string =>
  s
    .replace(new RegExp(`<\\/?${TAG_NAME}(?:[^>"']|"[^"]*"|'[^']*')*>`, 'gi'), '') // complete tags with quoted attributes
    .replace(new RegExp(`<\\/?${TAG_NAME_PREFIX}[^>]*$`, 'i'), '') // truncated tag start at end (< followed by (partial) tag name or </)
    .trim();
