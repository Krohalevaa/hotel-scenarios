# Hotel Scenarios Workflow (Node.js)

Полная копия workflow из n8n, переписанная на чистом Node.js (Express + RabbitMQ + axios + langchain).

## Структура проекта

- **`src/index.js`** — главная точка входа. Запускает HTTP-сервер и Worker.
- **`src/config.js`** — все переменные окружения и настройки (из файла `.env`).
- **`src/webhook.js`** — обработчик входящего POST-запроса `/generate-script`. Мгновенно отвечает успехом и отправляет задачу в фоновую очередь.
- **`src/scraper.js`** — отправляет запрос на Azure Scraping API и логика парсинга данных (извлечение телефона, email, фоток и т.д.).
- **`src/rabbitmq.js`** — логика Publisher/Consumer для общения с RabbitMQ.
- **`src/geo.js`** — обращение к OpenStreetMap (Nominatim) для получения координат, и Overpass API для поиска топовых достопримечательностей вокруг отеля.
- **`src/db.js`** — обращение к ClickHouse (сохранение массива достопримечательностей) через HTTP REST.
- **`src/ai.js`** — интеграция с Azure OpenAI с помощью LangChain. Содержит логику для извлечения сырых данных и преобразования в SQL, а также написания сценария (Script Writer).
- **`src/email.js`** — отправка письма клиенту со сценарием через Nodemailer.
- **`src/worker.js`** — фоновый процесс, который "достает" задачи из RabbitMQ и прогоняет их по всем шагам (Геолокация -> Достопримечательности -> ClickHouse SQL AI -> Azure Script AI -> Email).

## Как запустить

1. Установите зависимости в папке проекта:
   \`\`\`bash
   npm install
   \`\`\`

2. Создайте файл \`.env\` на основе \`.env.example\` и заполните все ключи доступа (особенно конфигурацию Azure OpenAI, ClickHouse Auth и пароль от Yandex почты). Убедитесь что у вас запущен RabbitMQ (либо локально, либо укажите URL сервера).

3. Запустите проект:
   \`\`\`bash
   npm start
   \`\`\`
   
   Или в режиме разработки:
   \`\`\`bash
   npm run dev
   \`\`\`

## Использование

Отправьте POST-запрос на \`http://localhost:3000/generate-script\`:

\`\`\`json
{
  "hotel_website_url": "https://example-hotel.com",
  "business_goal": "Увеличить продажи номеров на лето",
  "contact_email": "client@example.com",
  "city": "Paris",
  "language": "Russian"
}
\`\`\`
