# ПР2. Телеметрия канала (RTT, SRTT, джиттер, потери)

**Ветка:** `feature/latency-measurement`. Документы: `docs/Experiment_Config.md`, `docs/Latency_Report.md`, `docs/latency_samples.csv`.

## Адаптация
PING/PONG остаются, но измеряют качество связи пользователя с сервером и показываются в шапке (`SRTT`, `RTO`).
От RTT зависит, как часто имеет смысл слать позицию и когда считать сообщение потерянным.

## Где в коде
- Клиент: `public/app.js`, раз в 2 с `PING` (u64 µs, `performance.now()`), на `PONG` считается RTT только по часам клиента.
- Сервер: `server/server.js`, `case T.PING` добавляет `serverReceive/serverSend` (диагностика, часы не синхронны).
- `AdaptiveTimeout.onSample` считает `SRTT = 0.875·SRTT + 0.125·RTT`.
- Неизвестный/повторный PONG игнорируется (`pings.get` → `undefined`).

## Эксперимент
Серии: `baseline`, `delay_50`, `delay_100`, `jitter`, `loss_5`, `combined`, минимум 50 PING, интервал 2 с.
Эмуляция: Clumsy или параметры URL `?lag=100&loss=0.05` (зафиксируйте, что эмуляция на клиенте).
Джиттер = среднее |RTTᵢ − RTTᵢ₋₁|, потери = timeout / sent.

## Что осталось сделать вам
Выгрузка CSV `experiment_id;sample;sequence;sent_at_ms;rtt_ms;srtt_ms;status` (добавьте `console.log` в обработчик PONG и таймаут), три графика, отчёт, PR.

## Защита
- **Почему RTT по клиентским часам?** Часы сервера и клиента не синхронизированы.
- **Зачем SRTT?** Одиночные RTT шумят, нужна сглаженная оценка.
