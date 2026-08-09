export type Challenge = 'cloudflare' | 'datadome' | 'perimeterx' | 'akamai';
export type EscalationReason = 'status' | 'content_type' | 'thin_spa' | 'challenge' | 'empty_body';

export interface EscalationInput {
  status: number;
  contentType: string | null;
  html: string;
  extractedTextLength: number;
}

export interface EscalationVerdict {
  escalate: boolean;
  reason: EscalationReason | null;
}

/**
 * Ниже этого объёма текста страница подозрительна — но только вместе с перекосом
 * в сторону скриптов. Измерено по фикстурам: самая скудная настоящая страница
 * (playwright-docs) даёт 3303 символа, реальная гидрируемая (substack-post) — 915.
 */
const THIN_TEXT_THRESHOLD = 2_000;
/**
 * Во сколько раз байты скриптов должны перевешивать извлечённый текст, чтобы
 * считать страницу оболочкой. Измерено: у настоящих страниц с тяжёлым JS
 * (github-repo, nodejs-blog) отношение не превышает 13, у substack-post — 142.
 */
const SCRIPT_TO_TEXT_RATIO = 40;
const BOT_STATUSES = new Set([403, 429, 503]);

/** Технические маркеры защит. Намеренно не ищем слова в видимом тексте. */
const CHALLENGE_SIGNATURES: { name: Challenge; patterns: RegExp[] }[] = [
  {
    name: 'cloudflare',
    patterns: [
      /window\._cf_chl_opt/i,
      /\/cdn-cgi\/challenge-platform\//i,
      /<title[^>]*>\s*Just a moment/i,
      /cf-browser-verification/i,
    ],
  },
  {
    name: 'datadome',
    patterns: [/js\.datadome\.co/i, /datadome\s*=\s*['"]/i, /<title[^>]*>[^<]*datadome/i],
  },
  {
    name: 'perimeterx',
    patterns: [/id=["']px-captcha["']/i, /_pxAppId/i, /client\.perimeterx\.net/i],
  },
  { name: 'akamai', patterns: [/_abck=/i, /akam\/\d+\/[0-9a-f]+/i] },
];

/**
 * Область поиска маркеров: разметка (теги с атрибутами), содержимое скриптов и
 * заголовок документа. Видимый текст исключён намеренно — статья про Cloudflare
 * или строка «just a moment» в абзаце не делают страницу заблокированной.
 */
function markupOnly(html: string): string {
  const scripts = html.match(/<script\b[\s\S]*?<\/script>/gi) ?? [];
  const title = html.match(/<title\b[^>]*>[\s\S]*?<\/title>/i) ?? [];
  // Теги без текстовых узлов: сюда попадают id, class, src — но не проза.
  const tags = html.replace(/<script\b[\s\S]*?<\/script>/gi, '').match(/<[^>]+>/g) ?? [];
  return [...scripts, ...title, ...tags].join('\n');
}

export function detectChallenge(html: string): Challenge | null {
  const haystack = markupOnly(html);
  for (const { name, patterns } of CHALLENGE_SIGNATURES) {
    if (patterns.some((p) => p.test(haystack))) return name;
  }
  return null;
}

function scriptBytes(html: string): number {
  return (html.match(/<script[\s\S]*?<\/script>/gi) ?? []).reduce((sum, s) => sum + s.length, 0);
}

function isTextualContentType(contentType: string | null): boolean {
  if (!contentType) return true; // сервер промолчал — считаем текстом и проверим по содержимому
  const t = contentType.toLowerCase();
  return (
    t.includes('text/html') ||
    t.includes('application/xhtml') ||
    t.includes('text/plain') ||
    t.includes('+xml')
  );
}

function bodyIsEmpty(html: string): boolean {
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  const stripped = body
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .trim();
  return stripped.length === 0;
}

export function shouldEscalate(input: EscalationInput): EscalationVerdict {
  const { status, contentType, html, extractedTextLength } = input;

  if (!isTextualContentType(contentType)) {
    return { escalate: true, reason: 'content_type' };
  }
  // Раньше статуса: по названию защиты fetcher формулирует ошибку blocked.
  if (detectChallenge(html)) {
    return { escalate: true, reason: 'challenge' };
  }
  if (BOT_STATUSES.has(status)) {
    return { escalate: true, reason: 'status' };
  }
  const scripts = scriptBytes(html);
  if (bodyIsEmpty(html)) {
    // Ни одного видимого символа: со скриптами это оболочка, ждущая JS,
    // без них — ответ, из которого браузер тоже ничего не достанет, но
    // попытаться стоит: причина называет диагноз, а не просто «пусто».
    return { escalate: true, reason: scripts > 0 ? 'thin_spa' : 'empty_body' };
  }
  if (
    extractedTextLength < THIN_TEXT_THRESHOLD &&
    scripts > extractedTextLength * SCRIPT_TO_TEXT_RATIO
  ) {
    return { escalate: true, reason: 'thin_spa' };
  }
  return { escalate: false, reason: null };
}
