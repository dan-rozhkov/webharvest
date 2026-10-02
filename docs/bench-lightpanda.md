# Бенчмарк: Lightpanda 1.0.0 vs Chromium для scrape

Скрипт: `scripts/bench-lightpanda.ts`, список URL: `scripts/bench-lightpanda-urls.txt`
(23 страницы из кэша демона + 20 популярных сайтов/SPA). Запуск 2026-10-02, macOS arm64,
Lightpanda 1.0.0 (бинарь `lightpanda-aarch64-macos`), Chromium из Playwright со stealth.

Методика: `goto(waitUntil: 'load')` + 500 мс, `page.content()`, тот же `extract()`, что в демоне.
Lightpanda «прошёл» страницу, если статус < 400 и текста не меньше 70% от Chromium.
Пиковый RSS — сумма всех процессов браузера, выборка каждые 200 мс.

| | Chromium | Lightpanda |
|---|---|---|
| Concurrency 1: wall / median страницы | 103.2 s / 2055 ms | 100.9 s / 2305 ms |
| Concurrency 4: wall / median страницы | 33.2 s / 2327 ms | 30.8 s / 2195 ms |
| Пиковый RSS (c1 / c4) | 1778 / 2159 MB | 358 / 39 MB |
| Старт браузера | ~260–290 ms | ~40–150 ms |
| Открыл страниц | 41/43 | 42/43 |

Паритет по тексту: **38/41 (93%)** страниц, которые открыл Chromium.

Провалы Lightpanda — все на qa-financial.com: текста 23–65% от Chromium
(часть контента дорисовывается скриптами, которые Lightpanda не выполнил так же).
StackOverflow не открылся обоим (антибот), producthunt.com — Chromium получил ошибку.

Особенности, найденные при интеграции:
- Одна страница на CDP-подключение: вторая `newPage()` падает с
  `Target.createTarget: TargetAlreadyLoaded`. Для пула нужно подключение на воркера.
- Stealth-скрипт рассчитан на Chrome и к Lightpanda не применялся.

Вывод: по скорости паритет (время уходит в сеть, а не в рендер), по памяти выигрыш в 5–50 раз,
по полноте контента 93%. Имеет смысл как опциональный движок для `scrape` с фолбэком на Chromium
при коротком тексте; основным для `browser_*` (скриншоты, геометрия) не годится.

## Интеграция

`WEBHARVEST_SCRAPE_ENGINE=lightpanda` (или `scrapeEngine` в config.json) делает Lightpanda
основным движком scrape (`src/core/lightpanda.ts`, подключение CDP на каждый рендер), а
Chromium-пул — запасным (`fallbackBrowser` в `src/core/fetcher.ts`). Повтор на Chromium:
ошибка Lightpanda, челлендж, «нет текста» или текст короче 1000 символов. SSRF-отказ
по finalUrl и `too_large` не повторяются.
