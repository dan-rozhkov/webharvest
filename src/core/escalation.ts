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
 * в сторону скриптов и бедной разметкой. Порог лежит между реальной гидрируемой
 * страницей (substack-post: 915 извлечённых символов, 1033 видимых в разметке) и
 * короткой, но настоящей серверной страницей (release notes, товар — от ~1600).
 */
const THIN_TEXT_THRESHOLD = 1_200;
/**
 * Во сколько раз байты скриптов должны перевешивать извлечённый текст, чтобы
 * заподозрить оболочку. Измерено: у настоящих страниц с тяжёлым JS
 * (github-repo, nodejs-blog) отношение не превышает 13, у substack-post — 142.
 */
const SCRIPT_TO_TEXT_RATIO = 40;
/**
 * Главный признак оболочки: перекос скриптов над текстом, без оглядки на пороги.
 * Знаменатель — max(извлечено, видно в разметке), то есть «сколько текста тут
 * вообще есть»; та же величина, что и у порогового ветвления ниже, иначе две
 * ветви расходятся в понятиях.
 *
 * Константа выбрана измерением, а не на глаз (все числа — max-знаменатель):
 *   настоящие страницы:  nodejs-blog 9.40, github-repo 7.94, vitest-docs 4.96,
 *                        остальные ниже 0.3 — потолок популяции 9.40;
 *   настоящая оболочка:  substack-post 125.68, он же с 300 символами обвязки 97.33.
 * 80 лежит в 8.5 раза выше потолка настоящих страниц (требование было ≥3×) и всё
 * ещё ловит обвешанный substack. Между 63 и 97 зазор узкий — см. отчёт Task 7.
 */
const SHELL_SCRIPT_RATIO = 80;
const BOT_STATUSES = new Set([403, 429, 503]);

/** Технические маркеры защит. Намеренно не ищем слова в видимом тексте. */
const CHALLENGE_SIGNATURES: { name: Challenge; patterns: RegExp[] }[] = [
  {
    name: 'cloudflare',
    patterns: [
      /window\._cf_chl_opt/i,
      /<title[^>]*>\s*Just a moment/i,
      /cf-browser-verification/i,
      // Только маршруты интерстишела. Голый /cdn-cgi/challenge-platform/ сюда не
      // годится: JavaScript Detections (Bot Fight Mode) вставляет
      // /cdn-cgi/challenge-platform/h/g/scripts/jsd/<hash>/main.js в обычные
      // ответы 200, и по нему любая нормальная страница CF-сайта считалась бы
      // заблокированной — агент получил бы blocked на успешно скачанной статье.
      /\/cdn-cgi\/challenge-platform\/[^"'\s]*\/(?:orchestrate|chl_page|invisible|managed)\b/i,
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

/**
 * Сколько видимого текста несёт сама разметка, без скриптов и стилей. Это
 * структурный признак, независимый от извлекателя: он отличает оболочку, где
 * текста физически нет, от страницы, где текст есть, а извлекатель оплошал.
 */
function visibleTextLength(html: string): number {
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  return body
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim().length;
}

export function shouldEscalate(input: EscalationInput): EscalationVerdict {
  const { status, contentType, html, extractedTextLength } = input;

  // Внимание Task 9: сюда попадает и application/json — браузер не превратит его
  // в статью, так что «эскалировать» для таких типов означает лишь «HTTP-путь тут
  // не годится». Что делать с телом дальше, решает fetcher; это не недосмотр.
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
  const visible = visibleTextLength(html);
  if (visible === 0) {
    // Ни одного видимого символа: со скриптами это оболочка, ждущая JS,
    // без них — ответ, из которого браузер тоже ничего не достанет, но
    // попытаться стоит: причина называет диагноз, а не просто «пусто».
    return { escalate: true, reason: scripts > 0 ? 'thin_spa' : 'empty_body' };
  }
  // «Сколько текста тут вообще есть»: разметка знает не меньше извлекателя, и если
  // извлекатель оплошал на текстоносной странице, оболочкой её звать нельзя.
  const textPresent = Math.max(extractedTextLength, visible);
  const ratio = scripts / textPresent;

  // Основная ловушка оболочек: скрипты перевешивают текст неправдоподобно сильно.
  if (ratio > SHELL_SCRIPT_RATIO) {
    return { escalate: true, reason: 'thin_spa' };
  }
  // Запасная ловушка: текста почти нет ни по одной мерке, а скрипты всё же есть.
  // Ловит оболочки поскромнее, которые до основного перекоса не дотягивают.
  if (textPresent < THIN_TEXT_THRESHOLD && ratio > SCRIPT_TO_TEXT_RATIO) {
    return { escalate: true, reason: 'thin_spa' };
  }
  return { escalate: false, reason: null };
}
