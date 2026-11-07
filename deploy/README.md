# Личный Excalidraw на своём сервере

Режим self-hosted добавляет личное пространство поверх редактора Excalidraw:

- Вход через Google и/или Telegram OpenID Connect, доступ только по allowlist email-адресов или числовых Telegram ID.
- Проекты → папки → доски. Доски можно создавать и в корне проекта; папки в первой версии без вложенных папок.
- Создание, переименование и удаление проектов, папок и досок. Удаление проекта/папки удаляет вложенные доски после подтверждения.
- Автосохранение элементов и изображений в SQLite на сервере, индикатор сохранения и ручная кнопка «Сохранить».
- «Создать сеанс» открывает онлайн-сеанс по отдельной ссылке `/c/…`: гости рисуют без входа, видят изменения и курсоры друг друга. Изменения отправляются не чаще примерно 10 раз в секунду, курсоры — до 20 раз в секунду и только при движении. Отправляются изменённые элементы и новые изображения. Обновления приходят через SSE; резервная сверка версии — раз в 15 секунд. Правки разных элементов объединяются, удаления сохраняются как отметки удаления.
- «Поделиться доской» создаёт независимую ссылку `/s/…` только для просмотра. Получатель может скачать `.excalidraw` или открыть копию в excalidraw.com; API запрещает запись даже владельцу через эту ссылку. Просмотр загружается при открытии страницы; для актуализации нужно обновить страницу.
- «Новая ссылка сеанса» отключает прежних гостей, «Завершить сеанс» завершает совместную работу. «Новая ссылка просмотра» и «Закрыть просмотр» управляют только просмотром. Отзыв одной ссылки не затрагивает другой режим. Изменения участников остаются на доске, скачанные копии отозвать невозможно. Старые ссылки `/s/…` после обновления становятся ссылками только для чтения.
- Импорт и экспорт `.excalidraw`, экспорт изображений через меню редактора.

Node.js API использует встроенные HTTP, crypto и SQLite; дополнительных npm-зависимостей у сервера нет. База и изображения находятся в постоянном Docker-томе. У каждого аккаунта собственные проекты, папки и доски. Сервер проверяет владельца при чтении, изменении, синхронизации и управлении ссылками. Другие аккаунты могут открыть доску только по выданной ссылке просмотра или совместного сеанса. Синхронизация работает через HTTP API и SSE этого же сервера без Firebase или отдельного WebSocket-сервиса. Курсоры существуют только в памяти сервера и не попадают в базу или экспорт. Существующие локальные доски автоматически не переносятся: экспортируйте их в `.excalidraw`, создайте серверную доску и импортируйте файл через меню редактора.

## 1. Настройка Telegram

1. Создайте бота через [@BotFather](https://t.me/BotFather).
2. В настройках бота откройте **Login Widget**, зарегистрируйте Allowed URLs:
   - `https://draw.example.com`
   - `https://draw.example.com/api/auth/callback`
3. Сохраните **Client ID** и **Client Secret** из раздела Login Widget. Это OIDC Client Secret, а не Bot API Token.
4. Оставьте алгоритм подписи **RS256** (значение по умолчанию).
5. Укажите собственный числовой Telegram user ID в `TELEGRAM_ALLOWED_IDS`. Username с `@` не подходит. Не путайте свой ID с Client ID бота.

Используется Authorization Code Flow + PKCE, одноразовые state/nonce, проверка подписи через Telegram JWKS, issuer, audience и срока действия токена. Сессия хранится в HttpOnly/SameSite=Lax/Secure cookie и действует 7 дней; allowlist проверяется при каждом запросе.

Справочник: [официальная документация Telegram Login](https://core.telegram.org/bots/telegram-login).

## Настройка Google

1. Создайте OAuth-клиент типа **Web application** в [Google Cloud Console](https://console.cloud.google.com/auth/clients). Настройте экран согласия; если приложение в режиме Testing, добавьте входящие аккаунты в Test users.
2. В **Authorized redirect URIs** добавьте `https://draw.example.com/api/auth/google/callback` (замените домен на свой).
3. В `deploy/selfhost.env` укажите:

   ```dotenv
   GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=your-client-secret
   GOOGLE_ALLOWED_EMAILS=you@gmail.com,another@gmail.com
   ```

Адреса вводятся через запятую, без учёта регистра. Поддерживаются Gmail и управляемые Google Workspace аккаунты; внешние почтовые адреса личных Google-аккаунтов не принимаются. Адрес должен точно совпадать с email аккаунта: точки и `+alias` автоматически не объединяются. Каждый разрешённый аккаунт получает отдельное личное пространство. Входы через Google и Telegram считаются разными аккаунтами, автоматического объединения нет.

Можно включить оба способа входа или только Google (оставьте все `TELEGRAM_*` пустыми). Кнопки показываются только для настроенных провайдеров. Сервер проверяет подпись Google ID-токена, issuer, audience, срок, nonce и `email_verified`; схема описана в [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect).

После изменения списка примените конфигурацию:

```sh
docker compose --env-file deploy/selfhost.env -f docker-compose.selfhost.yml up -d
```

Удалённый из списка адрес теряет доступ и с уже выданной сессией. Списки и OAuth-секреты хранятся только на сервере.

## 2. Запуск через Docker Compose

Нужны Docker с Compose, домен с DNS-записью на сервер и HTTPS reverse proxy (например, уже установленный Caddy или Nginx).

Из корня репозитория:

```sh
cp deploy/selfhost.env.example deploy/selfhost.env
chmod 600 deploy/selfhost.env
```

Заполните `deploy/selfhost.env`:

```dotenv
APP_ORIGIN=https://draw.example.com
TELEGRAM_CLIENT_ID=123456789
TELEGRAM_CLIENT_SECRET=your-login-client-secret
TELEGRAM_ALLOWED_IDS=your-numeric-user-id
```

`APP_ORIGIN` должен точно совпадать с внешним origin, без пути. Секрет не передаётся в сборку браузера. Файл с секретом исключён из Git и Docker build context.

```sh
docker compose --env-file deploy/selfhost.env -f docker-compose.selfhost.yml up -d --build
docker compose --env-file deploy/selfhost.env -f docker-compose.selfhost.yml logs -f workspace
```

Контейнер слушает только `127.0.0.1:3000` хоста. Настройте HTTPS proxy для домена на `127.0.0.1:3000`. Пример для установленного на хосте Caddy — [Caddyfile.example](./Caddyfile.example). Если proxy работает в другом контейнере, подключите его к сети Compose и используйте `workspace:3000` вместо localhost.

Для Nginx отключите буферизацию SSE (`proxy_buffering off` для `/api/`), задайте `proxy_read_timeout 60s` и увеличьте `client_max_body_size` до `26m`: максимальный размер JSON доски вместе с base64 изображениями — 25 МБ. В браузере запросы идут на том же домене `/api/`; CORS не нужен. API не доверяет `X-Forwarded-*` при проверке origin, внешнее имя задаётся через `APP_ORIGIN`.

После запуска откройте домен, войдите через Telegram, создайте проект и доску. Перезагрузите страницу и проверьте сохранение, затем откройте ссылку в приватном окне и отзовите её.

## 3. Данные и резервная копия

В контейнере: `/data/workspace.sqlite` и служебные `-wal`/`-shm`. Docker-том `workspace-data` сохраняется при пересоздании контейнера. Не выполняйте `docker compose down -v`, если хотите сохранить данные.

Согласованная резервная копия через SQLite, пока приложение работает:

```sh
docker compose --env-file deploy/selfhost.env -f docker-compose.selfhost.yml exec workspace node -e 'const {DatabaseSync}=require("node:sqlite"); const db=new DatabaseSync("/data/workspace.sqlite"); db.exec("VACUUM INTO '\''/data/backup.sqlite'\''"); db.close()'
docker compose --env-file deploy/selfhost.env -f docker-compose.selfhost.yml cp workspace:/data/backup.sqlite ./workspace-backup.sqlite
docker compose --env-file deploy/selfhost.env -f docker-compose.selfhost.yml exec workspace node -e 'require("node:fs").unlinkSync("/data/backup.sqlite")'
```

`VACUUM INTO` создаёт согласованный снимок; имя назначения не должно уже существовать. Копия содержит доски, изображения и сессии, храните её приватно. Для восстановления остановите приложение, замените файл базы в томе резервной копией, удалите старые `-wal`/`-shm`, проверьте владельца файла (`node`, UID 1000) и запустите контейнер. Не заменяйте базу во время работы процесса.

## 4. Локальная разработка

Требуется Node.js 24 и Yarn 1.22.22 (через Corepack). В корне проекта:

```sh
corepack enable
yarn install --frozen-lockfile
```

Создайте `.env.development.local`:

```dotenv
VITE_APP_SELF_HOSTED=true
VITE_APP_ENABLE_ESLINT=false
VITE_APP_DISABLE_SENTRY=true
VITE_APP_ENABLE_TRACKING=false
```

Запустите API:

```sh
PORT=3001 APP_ORIGIN=http://localhost:3000 node --env-file=deploy/selfhost.env server/index.mjs
```

Затем во втором терминале `yarn start`. Vite проксирует `/api` на порт 3001. Для реальной проверки Telegram используйте зарегистрированный HTTPS-домен/туннель и соответствующий `APP_ORIGIN`. Встроенного обхода авторизации для разработки нет.

Production-сборка без Docker:

```sh
VITE_APP_SELF_HOSTED=true VITE_APP_DISABLE_SENTRY=true VITE_APP_ENABLE_TRACKING=false yarn build:app:docker
node --env-file=deploy/selfhost.env server/index.mjs
```

Без `VITE_APP_SELF_HOSTED=true` продолжает собираться исходное приложение Excalidraw. В self-hosted режиме не регистрируется PWA service worker, отключены встроенная аналитика страницы и автоматический переход на Excalidraw+. Проекты/доски не используют Firebase или сервис публикации Excalidraw; функции редактора вроде внешних встраиваний и каталога библиотек могут обращаться к сторонним сайтам по действию пользователя.

## 5. Проверки

```sh
node --test server/*.test.mjs
yarn test:typecheck
yarn eslint --max-warnings=0 excalidraw-app/workspace/*.tsx excalidraw-app/workspace/*.ts excalidraw-app/index.tsx
```

Тесты используют временную SQLite, локальный HTTP-сервер и собственные RSA-ключи вместо Telegram. Они проверяют валидацию токенов, allowlist, одноразовый вход, logout, запрет анонимного доступа к личному пространству, origin, структуру проектов/папок, сохранение изображений, конфликты версий, ротацию/отзыв ссылок, каскадное удаление, перезапуск сервера и очередь автосохранения.

Клиентская синхронизация (правки во время запроса, ошибки сети, удалённые настройки):

```sh
yarn vitest run excalidraw-app/workspace/BoardSync.test.ts
```

## Переход с общего пространства на личные доски

Новые проекты автоматически принадлежат создавшему их аккаунту; папки и доски наследуют владельца проекта. Существующие проекты без владельца сохраняются в базе, но скрыты от всех аккаунтов до назначения владельца. Их нельзя присвоить простым входом в систему.

Для переноса старого общего пространства войдите в нужный аккаунт, откройте `/api/me` и скопируйте поле `id`. Укажите его в `WORKSPACE_LEGACY_OWNER_ID` в `deploy/selfhost.env` и пересоздайте контейнер. Для Telegram это числовой ID, для Google — `google:<sub>`. При запуске сервер назначит этому аккаунту все проекты без владельца; уже назначенные проекты не изменятся. После переноса переменную можно очистить. Старые ссылки просмотра и совместных сеансов продолжают действовать до отзыва владельцем.
