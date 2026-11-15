# ПР1. Протокол и архитектура (Nomi)

**Ветка:** `feature/udp-echo` → `feature/protocol`. Документы: `docs/Architecture_Design.md`, `docs/Protocol_Specification.md`.

## Адаптация
| Задание | В Nomi |
|---|---|
| Жанр и топология | Социальное гео-приложение, **Dedicated server** (сервер знает всех друзей, авторитет по позициям) |
| MOVEMENT | `POSITION`: широта и долгота друга |
| SHOOT | `CHAT` и `REACTION` (дискретные события) |
| Лог команд | сервер пишет `REJECT_MOVE`, `AUTH_FAIL`, счётчики в `/stats` |

## Заголовок (8 байт, сетевой порядок)
| Поле | Тип | Смысл |
|---|---|---|
| packetType | u8 | PING 1, PONG 2, POSITION 3, CHAT 4, REACTION 5, ACK 6, CORRECTION 7, WELCOME 8, KEY_EXCHANGE 10, ENCRYPTED 11 |
| sequenceNumber | u16 | номер пакета отправителя |
| payloadSize | u16 | длина полезной нагрузки |
| protocolVersion | u16 | сейчас 1 |
| requiresAck | u8 | 1 — нужен ACK |

Новый тип `PROFILE 9`: JSON `{name≤20, bio≤60, color #rrggbb}`, сервер проверяет и рассылает профили всем в `WELCOME.roster`.
CHAT и REACTION содержат поле `to` (id адресата): сервер маршрутизирует их только ему (приватный диалог 1:1).

POSITION: `id u8 | lat i32 | lon i32` (градусы × 10⁷), всего 9 байт. CHAT/REACTION: JSON в UTF-8.

## Архитектура
Клиент: ввод (GPS, тап), карта, чат. Сервер: сессии, мир (`ents`), проверка, рассылка. Общий код — `shared/`.

## Реализация
`shared/protocol.mjs`: `encode`, `decode` (проверка длины, версии, типа, размера; невалидный пакет → `null`), `encPos`, `decPos`.
Тест: `npm test` (round trip и отбраковка).

## Чек-лист сдачи
- [ ] схема классов/модулей в `docs/Architecture_Design.md`
- [ ] таблица полей в `docs/Protocol_Specification.md` (скопируйте выше)
- [ ] PR, осмысленные коммиты, README проекта

## Защита
- **Почему Dedicated?** Позиции друзей надо проверять и фильтровать централизованно, P2P раскрыл бы IP друзей.
- **Зачем явная сериализация?** Выравнивание и порядок байт зависят от платформы.
