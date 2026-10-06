# C++ Playground

Онлайн-песочница и компилятор C++17 в браузере. Редактор использует Monaco Editor — тот же редакторный движок, который лежит в основе VS Code. Исходный код компилируется `g++` и запускается во временной директории.

## Локальный запуск

Требования: Node.js 20+ и `g++` или `clang++`.

```powershell
npm install
npm start
```

Откройте `http://127.0.0.1:3000`.

Для выбора компилятора:

```powershell
$env:CXX = "C:\путь\к\g++.exe"
npm start
```

## Публикация на облачный сервер

Рекомендуемый вариант — VPS с Ubuntu 24.04 LTS, Docker Engine и Docker Compose. Нужен домен, направленный A-записью на IP сервера. Caddy автоматически выпустит и обновит HTTPS-сертификат Let's Encrypt.

### 1. Подготовить сервер

Подключитесь по SSH:

```bash
ssh root@IP_СЕРВЕРА
```

Установите Docker:

```bash
curl -fsSL https://get.docker.com | sh
systemctl enable --now docker
```

Откройте только SSH, HTTP и HTTPS:

```bash
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable
```

### 2. Загрузить проект

Вариант через Git:

```bash
git clone https://github.com/ВАШ_АККАУНТ/ВАШ_РЕПОЗИТОРИЙ.git cpp-playground
cd cpp-playground
```

Или скопируйте файлы на сервер через `scp`/SFTP и перейдите в каталог проекта.

### 3. Настроить домен

Создайте `.env` на основе шаблона:

```bash
cp .env.example .env
nano .env
```

Укажите:

```env
DOMAIN=cpp.example.com
MAX_CONCURRENT_JOBS=2
RATE_LIMIT_MAX=20
```

До запуска проверьте, что `cpp.example.com` уже указывает на IP сервера, а порты 80 и 443 доступны из интернета.

### 4. Запустить

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f caddy
```

После этого сайт будет доступен по `https://cpp.example.com`.

Проверка health endpoint:

```bash
curl -fsS https://cpp.example.com/health
```

Ожидаемый ответ:

```json
{"status":"ok","activeJobs":0}
```

### 5. Обновить сайт

```bash
git pull
docker compose up -d --build
docker image prune -f
```

### 6. Остановить и удалить контейнеры

```bash
docker compose down
```

## Что уже сделано для production

- Monaco Editor отдается локально из npm-пакета, поэтому сайт не зависит от CDN.
- Docker-образ содержит Alpine Linux, `g++`, C++17 и стандартную библиотеку.
- Контейнер компилятора работает без сети, от root и Linux capabilities.
- Включены read-only filesystem, `no-new-privileges`, лимиты памяти, CPU, PID и временного каталога.
- Компиляция ограничена 15 секундами, запуск программы — 5 секундами.
- Ограничены размер исходника, stdin и stdout.
- Есть лимит 20 запусков в минуту с одного IP и максимум 2 параллельные задачи.
- Caddy принимает HTTPS и проксирует запросы во внутренний Unix-сокет.
- Добавлены security headers и `/health`.

## Важное ограничение безопасности

Запуск произвольного C++ — потенциально опасная операция. Текущая конфигурация подходит для небольшого публичного проекта, но перед большой нагрузкой или недоверенной аудиторией стоит вынести каждый запуск в отдельный одноразовый sandbox/worker с дополнительными seccomp/AppArmor-профилями, очередью задач и мониторингом.
