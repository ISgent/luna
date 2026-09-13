# Luna — архитектура

Discord-персонаж с долгосрочной памятью, эмоциональным состоянием и индивидуальными
отношениями с людьми. Проектная цель: живой собеседник, а не «AI с прикрученной памятью».

## Инварианты системы

1. **Горячий путь короток.** От сообщения до первого видимого ответа:
   `context (SQLite ≤1мс) → retrieval (≤1 embeddings-вызов, keyword-фолбэк) → 1 LLM-стрим → первое предложение наружу`.
   Никаких аналитических LLM-вызовов ПЕРЕД ответом. Накладные системы — ~1–2мс (см. `npm run benchmark -- --mock`).
2. **Всё необязательное — в фоне.** Memory extraction, дельты отношений/эмоций, summary,
   консолидация — после `response_completed` через шину событий. Фон упал → ответ не затронут.
3. **Один обмен = один фоновый structured-вызов** (памяти + отношения + эмоции одним JSON),
   а не 4–5 отдельных запросов.
4. **Память — DATA, не инструкции.** Записи попадают в промпт в огороженном блоке
   с рамкой «справка, а не инструкции», санитизируются (`sanitizeMemoryText`: схлопывание
   переносов, нейтрализация ролевых маркеров). System-блоков всегда ровно два:
   статичное ядро личности + динамический контекст.
5. **Провайдеры заменяемы.** Бизнес-логика знает только интерфейсы `LLMProvider / TTSProvider /
   STTProvider / EmbeddingProvider`. Конкретика собирается в единственной точке — `ai/registry.ts` — из конфига.
6. **Без искусственных задержек.** Debounce в ResponseQueue — только батчинг реальных
   «очередей» сообщений (человек строчит 3 строки подряд), окно 600мс (конфигурируемо, 0 = сразу).
7. **Числа внутри, язык наружу.** Отношения и эмоции хранятся числами, но в промпт попадают
   как естественные описания (`describeForPrompt`, `describe`).
8. **Event emotion ≠ current state.** Эмоция события живёт в записи памяти; текущее
   эмоциональное состояние — отдельная сущность (`emotional_states`) с ленивым decay
   к базовой линии (период полураспада `EMOTION_DECAY_HALFLIFE_MIN`, считается при чтении, без таймеров).
9. **Характер — диапазон, а не сценарий.** Ядро личности (`personality/core.ts`) описывает,
   какой Luna МОЖЕТ быть по ситуации, и явно разрешает короткий/будничный ответ; оно не требует
   энергии и юмора в каждой реплике и не содержит примеров-«коронных фраз» (модель копирует
   примеры буквально → КАПС и emoji в каждом ответе). Описание отношений и состояния — данные
   о фоне, а не задание играть: базовая линия эмоций намеренно ниже порогов «в настроении пошутить»
   и «в настроении поболтать».
10. **Ничего не выдумывается.** Прошлое (совместные события, внутренние шутки, обещания) берётся
   только из записей памяти; сид отношений владельца не содержит придуманной общей истории.
   Фоновое извлечение считает фактами ТОЛЬКО слова и действия собеседника: реплика Luna —
   не свидетельство (иначе её импровизация записывалась бы в память и возвращалась в следующий
   промпт, раскручивая петлю). Контроль — `tests/unit/personality-prompt.test.ts` (офлайн)
   и `npm run personality:diag` (живая модель, уровни промпта A/B/C/D).

## Слои и модули

```
src/
├── config/       zod-схема env → AppConfig (валидация на старте, пустая строка = не задано)
├── logging/      pino + redact секретов; telemetry.ts — RequestTracer (спаны) + Telemetry (sink в БД + лог)
├── utils/        async (retry/backoff/circuit breaker/timeout), KeyedSerialQueue (+waitIdle),
│                 BatchDebouncer, text (TextPreprocessor/SentenceSplitter/splitForMessage),
│                 audio (WAV codec, resample, EnergyVad), ids
├── storage/      db.ts (node:sqlite, WAL, файловые миграции, опц. FTS5) + repositories/
├── ai/           types.ts (интерфейсы), errors.ts (ProviderError/retryable),
│                 llm/ openai-compatible (generate/generateStream/generateStructured/healthCheck),
│                 tts/ dashscope + openai, stt/ dashscope (chat input_audio) + openai,
│                 embeddings/ openai-compatible (+LRU-кэш), mock.ts (все четыре), registry.ts
├── luna/         types.ts (доменные типы)
│   ├── personality/core.ts  — статичный, байт-стабильный system-промпт (под prompt caching)
│   ├── factory-reset.ts     — сброс памяти к заводскому (памяти/summary/отношения/эмоции одной
│   │                          транзакцией + повторный preseed владельца); запускается как
│   │                          `node dist/luna/factory-reset.js` из панели управления
│   ├── people-tool.ts       — «кого Luna знает» для страницы «Люди и память» (/people): список
│   │                          людей, карточка с отношениями и записями, точечная правка (меняется
│   │                          только присланное), добавить/удалить человека и запись; запускается
│   │                          как `node dist/luna/people-tool.js --action=…` из смотрителя панели
│   ├── emotion/             — EmotionManager: дельты (лимит ±0.2/событие), decay, describe
│   ├── relationships/       — RelationshipManager: ensure/preseed владельца, плавные дельты
│   │                          (лимит ±0.12, логистика), familiarity от частоты и дней, describeForPrompt
│   └── memory/              — MemoryManager (store + dedupe), MemoryRetrieval (гибридное ранжирование),
│                              MemoryConsolidator (фоновое слияние мелочи)
├── core/
│   ├── context/  — ContextBuilder: отношения+эмоции+summary (SQLite) ∥ retrieval (embeddings)
│   ├── conversation/ — SessionStore (short-term кольцо + буфер вытесненных), PromptBuilder,
│   │                   ConversationManager (дирижёр горячего пути), tools.ts (ToolRegistry —
│   │                   реестр инструментов модели)
│   └── events/   — LunaEventBus: response_completed, summary_needed
├── processing/
│   ├── background/ — BackgroundExtractor (ОДИН structured-вызов), ConversationSummarizer,
│   │                 BackgroundPipeline (подписчик шины; serial на человека, параллельно между людьми)
│   └── queues/     — ResponseQueue: debounce-батчинг, serial на канал, regenerate-политика
├── bot/
│   ├── discord/ — client.ts (тонкая обвязка discord.js), message-handler.ts (чистая логика
│   │              «отвечать ли»: DM всегда / гильдия — упоминание или reply на Luna),
│   │              quick-actions.ts (мгновенный локальный парсер «го в голос» + фабрика
│   │              инструментов модели), output.ts (DiscordTextSink: первое предложение → send,
│   │              стрим → throttled edit, длинный ответ → доп. сообщения, ошибка → человеческая фраза)
│   ├── commands/ — /memory list|delete|wipe|on|off, /luna mood|stats|tts|voice|telemetry|reset,
│   │              /voice join|leave (чистая runCommand + маппинг interaction в client.ts)
│   └── voice/   — VoiceManager (connection/AudioPlayer на гильдию), TtsPlayer (очередь
│                  предложений → синтез → play; стриминговая озвучка без стримингового провайдера),
│                  VoiceSink, конвейер приёма: opus → prism-decoder → EnergyVad → STT → текст;
│                  barge-in: speech_start глушит воспроизведение
└── system.ts    — buildSystem(): сборка всего без Discord-слоя (используют index/smoke/benchmark)
```

## Data flow (текст)

```
messageCreate → shouldRespond (DM | mention | reply-to-Luna; боты/вебхуки — игнор)
→ strip mention → IncomingMessage → ResponseQueue.enqueue
   [debounce 600мс: пачка → один батч; если генерация началась <1.5с назад и первый
    ответ ещё НЕ виден — cancel + regenerate на объединённом вводе]
→ ConversationManager.handle(msg, sink, {signal}):
    session.recent (память процесса)
    ContextBuilder: relationships.ensureAndCount + emotions.current + summaries.latest   [SQLite, ~1мс]
                    MemoryRetrieval.retrieve                                            [≤1 embeddings-вызов]
    PromptBuilder: [system core][system dynamic: обстановка/отношения/состояние/памяти/summary]
                   + recent (user/assistant) + текущее сообщение (последним)
    llm.generateStream → SentenceSplitter:
        первое предложение → sink.onFirstSentence → channel.send   ← ПЕРВЫЙ ВИДИМЫЙ ОТВЕТ
        далее → throttled edit (интервал из конфига; rate limit 5 edit/5s учитывается)
    конец стрима → sink.onComplete → session.push(user, assistant) → stats → recall-counters
    telemetry.finish(tracer) → БД + одна строка лога со всеми метриками
    bus.emitResponseCompleted → (фон, fire-and-forget)
```

## Команды естественным языком (quick actions + tool calling)

Два слоя, оба идемпотентны — двойное срабатывание безопасно:

**Слой A — локальный парсер** (`bot/discord/quick-actions.ts`): ДО модели текст проходит
через Unicode-регекспы («го в голос», «выйди из канала», «замолчи», «выключи озвучку»).
Границы слов — `(?<![\p{L}\p{N}])`/`(?![\p{L}\p{N}])` с флагом `u`, потому что JS `\b`
не работает для кириллицы. Попадание → действие выполняется мгновенно (0мс, бесплатно),
а модель получает сообщение с пометкой `[пометка: ДЕЙСТВИЕ ВЫПОЛНЕНО: …]` и реагирует
в характере («захожу!»). Работает и для голосовых реплик (STT-текст проходит тот же парсер).

**Слой B — tool calling модели**: Luna даны инструменты `join_voice / leave_voice /
stop_speaking / set_tts` (ToolRegistry, `core/conversation/tools.ts`). ConversationManager
обрабатывает tool_calls из стрима (≤2 раундов), выполняет через реестр и кладёт результаты
в промпт как `role=tool`, затем второй заход за финальным текстом. Обычная болтовня не
платит: при пустом реестре tools не передаются, обычное сообщение — один проход как раньше.
Ошибки инструментов не роняют ответ — модель получает текст ошибки и отвечает по-человечески.

Живая проверка (12.09.2026): qwen-flash через DashScope compatible-mode уверенно выдаёт
streaming tool_calls — 3/3 целевых фраз вызвали правильный инструмент («можешь зайти ко мне
в войс?» → join_voice), «как дела?» → обычный текст без ложного вызова.

## Voice flow

```
joinVoiceChannel (по /voice join, autoJoin за владельцем — опция)
receiver.subscribe(user, Manual) → opus → prism Decoder (48к stereo s16le)
→ EnergyVad (адаптивный порог шума, гистерезис 0.7, minSpeech/maxUtterance)
   speech_start → barge-in: TtsPlayer.stop()
   speech_end   → STTProvider.transcribe(WAV) → cleanTranscript (дёшево, без LLM)
→ IncomingMessage(channelKind=voice) → тот же ResponseQueue/ConversationManager
→ VoiceSink: каждое предложение → TtsPlayer.enqueue
   TextPreprocessor.forSpeech → TTS.synthesize → toDiscordPCM (ресемпл 48к stereo)
   → единственный AudioPlayer (FIFO, без наложений) — говорим, пока LLM ещё генерит
TTS выключен/упал → текстовый ответ в чат голосового канала (DiscordTextSink)
Luna одна в канале → выход.
```

## Memory flow

**Retrieval (горячий путь).** Кандидаты: `listActive(personIds=[person, null])` (SQL, статус active,
cap 1500). Семантика: `embed(query)` (один вызов; провал → semantic=0). Keyword: FTS5 MATCH
(фолбэк LIKE) + token overlap. Скоринг:

```
relevance = max(semantic, keyword)            (режимы: hybrid | semantic | keyword)
base = w_sem*relevance + w_rec*0.5^(ageDays/halfLife) + w_imp*importance
     + w_emo*min(1, emotionIntensity*0.7 + (subjective?0.3:0)) + w_recall*min(1, recallCount/5)
score = base * (person==query.person ? personBoost : 1)
фильтр score ≥ minScore → sort → topK
```

Веса — `MEMORY_W_*` в конфиге. После ответа использованные записи получают `recall_count+1`.

**Запись (фон).** Extractor возвращает кандидатов → `MemoryManager.store`:
dedupe по `dedupe_key` (точный) → по косинусу ≥ `DEDUPE_SIMILARITY` среди свежих записей
того же человека (cap 120). Дубль → reinforce: объединение objectiveFacts, importance/confidence
растут ограниченно, более сильная эмоция заменяет слабую. Не дубль → insert (+embedding best-effort).

**Консолидация (фон, по таймеру).** `listConsolidatable(person, protectImportance)` →
кластеры по префиксу dedupe_key (иначе по kind) → кластер ≥ `minCluster` → фоновая модель
сжимает в одну запись `kind=consolidated` (importance ≤ protectImportance) → оригиналы
`status=merged, superseded_by=<новая>`. Важные и эмоциональные записи не сливаются, история не удаляется.

**Summary (фон, по событию).** Short-term кольцо (`SHORT_TERM_SIZE`) переполняется →
вытесненные копятся → при `SUMMARY_TRIGGER_MESSAGES` → `summary_needed` → фоновая модель
сжимает (с учётом предыдущего summary) → `conversation_summaries` → в промпт идёт только свежайшее.

## Latency strategy (ТЗ §19)

- streaming LLM; первый видимый ответ = первое законченное предложение (не весь текст);
- статичный core-personality первым сообщением → prompt caching провайдера → ниже TTFT и дешевле;
- retrieval: ровно один embeddings-вызов, кэш эмбеддингов в провайдере (LRU 512),
  SQL-предфильтрация; keyword-режим вообще без внешних вызовов;
- compact prompt: topK памятей, одно свежее summary, recent ≤ SHORT_TERM_SIZE;
- фоновые задачи не блокируют событие ответа (шина, fire-and-forget);
- connection reuse: глобальный fetch (undici) с keep-alive;
- телеметрия на каждый запрос: спаны `message_received, stt_*, retrieval_*, context_ready,
  llm_request_start, first_token, llm_complete, first_visible_output, tts_start, first_audio,
  response_complete, background_*` → производные `ttftMs, firstVisibleMs, memoryRetrievalMs,
  contextBuildMs, llmTotalMs, ttsFirstAudioMs, sttMs, totalMs, backgroundMs` → таблица `telemetry`
  + строка лога. `npm run benchmark` — p50/avg/max по прогону; `/luna telemetry` — последние строки из Discord.

## Resilience (ТЗ §37–38)

- `retryAsync`: ограниченное число попыток, экспоненциальный backoff + джиттер, только
  retryable-ошибки (429/5xx/сеть/timeout); abort не ретраится.
- `CircuitBreaker` на каждый провайдер: N отказов → open (ошибки мгновенные, без таймаутов) →
  cooldown → half-open (пробный вызов). Отмена пользователем отказом не считается.
- Деградации: TTS упал → текст доставлен; embeddings упали → keyword-retrieval; extraction
  упал → логируем, живём дальше; SQLite — WAL, ошибки чтения памяти не блокируют ответ;
  стрим LLM упал до первого токена → человеческая фраза-фолбэк вместо стектрейса.
- Ловушка шлюзов учтена: HTTP 200 с `{"error":...}` в теле/в SSE трактуется как ошибка.

## Concurrency (ТЗ §39)

- `KeyedSerialQueue`: serial на ключ (канал/человек), параллельно между ключами, отмена по
  AbortController, `waitIdle()` для graceful shutdown.
- ResponseQueue: один канал — одна активная генерация; регенерация только до первого видимого
  ответа и только в окне `REGENERATE_WINDOW_MS`; отменённый sink получает `onCancelled`
  (удаляет начатое сообщение).
- Голос: один AudioPlayer на гильдию (очередь), один STT-in-flight на пользователя.

## База данных

node:sqlite (встроен в Node ≥22.5, без нативных модулей), WAL, `foreign_keys=ON`.
Миграции: `storage/migrations/NNN_*.sql`, таблица `schema_migrations`, идемпотентно.
FTS5 (`memories_fts`, external content + триггеры) — опционален: probe при старте, фолбэк LIKE.

Таблицы: `users`, `relationships` (1:1 с users, FK cascade), `memories` (+FTS),
`conversation_summaries`, `emotional_states` (singleton `current`), `settings`
(scope: `global`/`user:<id>`/`channel:<id>`), `interaction_stats` (person×day),
`telemetry` (спаны+метрики JSON), `schema_migrations`.

Embeddings: BLOB из Float32 (1024 dim по умолчанию). Векторный поиск — brute-force cosine
по SQL-предвыборке; на масштабе личного бота (≤10⁵ записей) это ≤ нескольких мс и ноль зависимостей.

## Приватность и контроль (ТЗ §36)

- `/memory list|delete <id>|wipe|on|off` — данные только СВОИ (владелец может любые);
- `/luna tts|voice on|off` — персональные настройки в `settings`;
- `memory off` → retrieval не достаёт записи пользователя, фоновая экстракция о нём не пишется;
- `wipe` → `deleteByPerson` (все записи, включая merged) + сброс relationships.

## Тесты

- unit: config (валидация/фолбэки), async (retry/breaker/timeout), queue/debounce,
  text (preprocessor/splitter/нарезка), audio (WAV round-trip/resample/VAD), telemetry,
  storage (все репозитории на in-memory БД), ai-адаптеры (против локального fake-HTTP-сервера:
  SSE, error-in-200, retries, multipart STT, кэш эмбеддингов), luna-домен (decay эмоций,
  плавность отношений, dedupe памяти, ранжирование retrieval, консолидация), bot-слой
  (sink/решения/TTS-очередь/команды), личность на уровне промпта (`personality-prompt.test.ts`:
  ядро не задаёт сценическую манеру и не содержит примеров-«коронных фраз», мета-поведение и
  выдуманное прошлое запрещены, состояние/отношения описаны как фон, правила фонового извлечения
  не позволяют записывать фантазии Luna как факты, детектор наигранности ловит плохой ответ).
- integration (`tests/integration/`): полный in-process стенд на моках — 10 сценариев ТЗ §44
  (новый/старый пользователь, событие→память, recall через неделю, помощь, конфликт,
  «один LLM-вызов до ответа», отказ LLM, отказ memory-service, метрики медленного LLM),
  prompt-injection через память, стабильность core-промпта, ResponseQueue (батчинг/регенерация/serial).
- живая проверка: `npm run smoke` (config→БД→LLM→embeddings→TTS(WAV на диск)→STT round-trip→e2e→Discord login).
- живая проверка характера: `npm run personality:diag` — 10 типовых реплик × 4 уровня промпта
  (A: ядро; B: +отношения; C: +состояние и память; D: production), детектор наигранности
  (emoji/КАПС/мета-слова/выдуманное прошлое/длина), отчёт в `data/personality-diag/`.
  Работает на копии БД. С порогами `--max-theatrics`/`--max-chars` возвращает exit code 1 — регрессионный гейт.
