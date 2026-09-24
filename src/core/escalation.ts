export type Challenge = 'cloudflare' | 'datadome' | 'perimeterx' | 'akamai';
export type EscalationReason = 'status' | 'content_type' | 'thin_spa' | 'challenge' | 'empty_body';

export interface EscalationInput {
  status: number;
  contentType: string | null;
  html: string;
  extractedTextLength: number;
  /** Материал без озаглавленных подвалов/сайдбаров (`Extracted.proseTextLength`).
   *  Нужен правилу Turnstile-виджета: обвязка стены не должна её прикрывать. */
  extractedProseTextLength?: number;
  /** Есть ли в извлечённом материале поля для человека (`Extracted.hasFormField`).
   *  Нужно правилу Turnstile-виджета: страница формы — не стена. */
  contentHasFormField?: boolean;
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
 * Маркеры Turnstile-ВИДЖЕТА. Разметка у виджета и у стены из виджета одна и та
 * же — скрипт `challenges.cloudflare.com/turnstile` плюс `div.cf-turnstile`, —
 * но виджет ставят и на совершенно обычные страницы: форма логина, подписка на
 * рассылку, контактная форма в конце статьи. Считать это блокировкой значит
 * докладывать агенту `blocked` («закрыта защитой cloudflare») на странице,
 * которую он спокойно прочитал бы.
 *
 * Поэтому виджет становится стеной только тогда, когда читаемого текста на
 * странице почти нет (см. WIDGET_WALL_TEXT_THRESHOLD). Измерено на живых
 * страницах: статья с встроенным виджетом — 11 435 символов видимого текста и
 * `turnstile` в разметке (не стена); стена из виджета (nowsecure.nl) — 64
 * символа (стена).
 *
 * Только для HTTP-пути: в живом DOM то же различие делает isChallengeActive
 * (см. challenge.ts) по структурным id интерстишела.
 */
const WIDGET_SIGNATURES = [/challenges\.cloudflare\.com\/turnstile/i, /cf-turnstile/i];

/**
 * Сколько читаемого МАТЕРИАЛА должно быть на странице, чтобы виджет считался
 * встроенной формой, а не стеной. Величина считается по тексту ПОСЛЕ извлечения
 * (обвязка уже срезана), а не по сырому видимому тексту: стена, отданная внутри
 * шаблона сайта, приносит с собой меню и подвал, и по сырому тексту она
 * выглядит «страницей» — одна обвязка легко даёт больше 1200 символов, поэтому
 * сырая мера пропускала бы такую стену как контент.
 *
 * Порог намеренно тот же, что THIN_TEXT_THRESHOLD: понятие «страница без
 * текста» должно быть в файле одно, иначе пороги разъедутся в трактовке.
 * Измерено: стена — 43-64 символа материала, статья со встроенным виджетом —
 * 11 435.
 */
const WIDGET_WALL_CONTENT_THRESHOLD = THIN_TEXT_THRESHOLD;

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

/**
 * Меры материала, которые нужны правилу Turnstile-виджета. Их даёт extractor
 * (см. `Extracted`), потому что вердикт о виджете — вопрос о материале, а не о
 * строке HTML: строковые проверки на этом и провалились (видели `<input>` в
 * вырезанном `<nav>`, в `<template>` и в строке JS, а `\btype` путали с хвостом
 * `data-type`/`xml:type`).
 */
export interface ChallengeOptions {
  /**
   * Объём читаемого материала после извлечения, БЕЗ сохранённых озаглавленных
   * подвалов и сайдбаров (`Extracted.proseTextLength`). Именно эта мера решает,
   * стена перед нами или статья: обвязка стены (меню, подвал сайта) приходит
   * вместе со стеной и не должна превращать её в материал. `undefined` —
   * измерить не удалось (так зовётся нетекстовое тело, из которого извлекать
   * нечего).
   */
  proseTextLength?: number;
  /**
   * Есть ли в материале поля, которые заполняет человек
   * (`Extracted.hasFormField`). `undefined` — материал не измерялся.
   */
  hasFormField?: boolean;
}

/**
 * Есть ли на странице активная защита — и какая именно.
 *
 * Меры материала нужны только правилу Turnstile-виджета (стена или встроенная
 * форма, см. WIDGET_SIGNATURES); остальные сигнатуры самодостаточны. Если мер
 * нет, виджет считается стеной — так зовётся нетекстовое тело. Передавать
 * пустой объект вместо честных мер из HTML-пути нельзя: это вернёт ложные
 * `blocked` на страницах со встроенной формой.
 */
export function detectChallenge(html: string, options: ChallengeOptions = {}): Challenge | null {
  const haystack = markupOnly(html);
  for (const { name, patterns } of CHALLENGE_SIGNATURES) {
    if (patterns.some((p) => p.test(haystack))) return name;
  }
  if (!WIDGET_SIGNATURES.some((p) => p.test(haystack))) return null;
  // Материала достаточно — это статья с виджетом, а не стена.
  if ((options.proseTextLength ?? 0) >= WIDGET_WALL_CONTENT_THRESHOLD) return null;
  // Материала нет, но есть что заполнить — это страница формы, и отдать её
  // агенту честнее, чем докладывать blocked про всю страницу.
  if (options.hasFormField) return null;
  return 'cloudflare';
}

function scriptBytes(html: string): number {
  return (html.match(/<script[\s\S]*?<\/script>/gi) ?? []).reduce((sum, s) => sum + s.length, 0);
}

/** Exported so fetcher.ts can gate on content-type BEFORE running extract() —
 *  a binary body should never be decoded to UTF-8 and pushed through JSDOM
 *  just to have shouldEscalate() throw the result away a moment later. */
export function isTextualContentType(contentType: string | null): boolean {
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
  const { status, contentType, html, extractedTextLength, extractedProseTextLength, contentHasFormField } =
    input;

  // Внимание Task 9: сюда попадает и application/json — браузер не превратит его
  // в статью, так что «эскалировать» для таких типов означает лишь «HTTP-путь тут
  // не годится». Что делать с телом дальше, решает fetcher; это не недосмотр.
  if (!isTextualContentType(contentType)) {
    return { escalate: true, reason: 'content_type' };
  }
  // Раньше статуса: по названию защиты fetcher формулирует ошибку blocked.
  // Меры материала передаём обязательно: правило Turnstile-виджета решает,
  // стена это или встроенная форма, именно по ним.
  if (
    detectChallenge(html, {
      proseTextLength: extractedProseTextLength,
      hasFormField: contentHasFormField,
    })
  ) {
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
