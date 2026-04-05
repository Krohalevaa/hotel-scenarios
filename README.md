# Hotel Scenarios Workflow (Node.js)

A full copy of the n8n workflow, rewritten in plain Node.js using Express, RabbitMQ, axios, and LangChain.

## Project structure

- **`src/index.js`** — main entry point. Starts the HTTP server and the worker.
- **`src/config.js`** — all environment variables and settings loaded from `.env`.
- **`src/webhook.js`** — handler for the incoming POST request to `/generate-script`. Responds immediately with success and sends the task to the background queue.
- **`src/scraper.js`** — sends requests to the Azure Scraping API and contains the parsing logic for extracted data such as phone, email, photos, and more.
- **`src/rabbitmq.js`** — publisher and consumer logic for RabbitMQ communication.
- **`src/geo.js`** — integration with OpenStreetMap (Nominatim) for coordinates and Overpass API for finding top nearby attractions around the hotel.
- **`src/db.js`** — ClickHouse access layer for storing attraction arrays through HTTP REST.
- **`src/ai.js`** — Azure OpenAI integration through LangChain. Contains logic for extracting raw data, transforming it for SQL-related processing, and writing the final script.
- **`src/email.js`** — sends the final script to the client via Nodemailer.
- **`src/worker.js`** — background process that pulls tasks from RabbitMQ and runs them through all steps: geolocation, attractions, ClickHouse SQL AI, Azure script AI, and email delivery.

## How to run

1. Install dependencies in the project folder:
   ```bash
   npm install
   ```

2. Create a `.env` file based on `.env.example` and fill in all required credentials, especially Azure OpenAI configuration, ClickHouse auth, and the Yandex mail password. Make sure RabbitMQ is running either locally or via a configured server URL.

3. Start the project:
   ```bash
   npm start
   ```

   Or run it in development mode:
   ```bash
   npm run dev
   ```

## Usage

Send a POST request to `http://localhost:3000/generate-script`:

```json
{
  "hotel_website_url": "https://example-hotel.com",
  "business_goal": "Increase summer room bookings",
  "contact_email": "client@example.com",
  "city": "Paris",
  "language": "English"
}
```
