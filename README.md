# Hotel Scenarios

Hotel Scenarios is a Node.js application that turns hotel website data into short-form marketing video scripts.

It accepts hotel requests from a public page or an authenticated dashboard, scrapes hotel information, enriches it with geolocation and nearby attractions, selects the most relevant local places, generates a 15-second script with Azure OpenAI, stores the result in Supabase, and sends the finished script by email.

## What the application does

The platform automates the full scenario generation pipeline:

1. Accepts a hotel request through a public or authenticated API flow.
2. Scrapes the hotel website through an external scraping service.
3. Extracts structured hotel data such as name, description, amenities, offers, and images.
4. Publishes the request to a RabbitMQ-backed processing flow.
5. Creates a scenario record in Supabase.
6. Predicts a cleaner hotel name for OpenStreetMap lookup.
7. Resolves hotel coordinates and address data.
8. Searches for nearby public places, first using guest-preference-based category narrowing and then a broader fallback when needed.
9. Uses AI to select the most relevant nearby places.
10. Generates a production-ready 15-second script in the requested language.
11. Saves the final script and related source data in Supabase.
12. Sends the completed script to the target email address.

## Core capabilities

- Public and authenticated script generation flows.
- Batch processing for authenticated users.
- Background processing with RabbitMQ HTTP Management API plus in-memory fallback processing when RabbitMQ is unavailable.
- Hotel website scraping through an external scraper endpoint.
- Geocoding and nearby place discovery using OpenStreetMap, Nominatim, and Overpass.
- Guest-preference-aware attraction category narrowing.
- AI-assisted place selection and script generation.
- Supabase-backed profiles, scenarios, source data, discovered attractions, and avatar uploads.
- Built-in static frontend pages for the public entry point and authenticated dashboard.
- Email delivery of completed scripts.
- Docker support for local containerized startup.

## Architecture overview

The project runs as a single Express application with an internal worker loop:

- **HTTP layer**: receives requests, serves static frontend files, exposes public configuration, and mounts API routes.
- **Request preparation layer**: scrapes hotel websites, extracts structured data, and prepares payloads for processing.
- **Queue layer**: publishes jobs through the RabbitMQ HTTP API and falls back to direct in-process execution when queue operations fail.
- **Worker layer**: consumes jobs, enriches hotel data, selects attractions, generates scripts, persists results, and sends emails.
- **Data layer**: stores profiles, scenarios, hotel source data, and discovered attractions in Supabase.
- **Frontend layer**: serves static pages from the public directory.

## Verified project structure

- **`src/index.js`** — Express bootstrap, JSON middleware, static file serving, public config endpoint, and worker startup.
- **`src/webhook.js`** — public and authenticated API routes, batch processing entry point, profile endpoints, and avatar upload endpoint.
- **`src/worker.js`** — background processing pipeline for scenario creation, geocoding, attraction discovery, AI generation, persistence, and email delivery.
- **`src/rabbitmq.js`** — RabbitMQ HTTP API publishing, polling consumer, and fallback job queue.
- **`src/scraper.js`** — external scraper integration and structured hotel data extraction.
- **`src/geo.js`** — city caching, geocoding, OpenStreetMap search, and nearby public place discovery.
- **`src/placePreferences.js`** — guest preference parsing and attraction category definitions.
- **`src/ai.js`** — Azure OpenAI chat calls, place selection, hotel name prediction, and final script generation.
- **`src/db.js`** — Supabase persistence for scenarios, source data, attractions, profiles, and avatars.
- **`src/auth.js`** — Supabase token validation middleware for protected routes.
- **`src/email.js`** — SMTP transport creation and retry-based email delivery.
- **`src/config.js`** — environment variable loading and runtime configuration defaults.
- **`src/logger.js`** — application logging helpers.
- **`public/index.html`** — public-facing page.
- **`public/dashboard.html`** — authenticated dashboard UI.
- **`supabase/schema.sql`** — database schema, indexes, triggers, and row-level security policies.
- **`docker-compose.yml`** — local multi-container setup.
- **`Dockerfile`** — application container definition.

## Runtime flow

1. A client sends a request to a public or authenticated endpoint.
2. The server validates the request context.
3. The application scrapes the hotel website and extracts structured hotel data.
4. The payload is published to the processing queue.
5. The worker creates a scenario record in Supabase.
6. The worker predicts a cleaner hotel name for map lookup.
7. The worker resolves coordinates and address information.
8. Nearby places are searched using narrowed categories derived from guest preferences.
9. If the narrowed search returns no results, the worker falls back to a broader category search.
10. AI selects the most relevant nearby places and categories.
11. AI generates the final 15-second script, with a structured fallback if generation fails or returns invalid output.
12. The scenario is marked as completed or failed, and the final script is emailed to the requester.

## Tech stack

- Node.js
- Express
- Axios
- Supabase
- RabbitMQ HTTP Management API
- Azure OpenAI
- Nodemailer
- Docker
- OpenStreetMap / Nominatim / Overpass

## Requirements

Before running the project, make sure you have:

- Node.js 18 or newer.
- npm.
- A Supabase project.
- RabbitMQ access through the HTTP Management API.
- Azure OpenAI credentials.
- SMTP credentials for outbound email delivery.
- Access to the external scraper service configured in the environment.

## Environment variables

Create a local **`.env`** file based on **`.env.example`**.

The application reads the following configuration values from **`src/config.js`**:

### Server and scraping

- **`PORT`** — HTTP server port. Defaults to `3000`.
- **`SCRAPER_API_URL`** — external scraper endpoint used by the website scraping module.

### Guest-mode defaults

- **`GUEST_USER_ID`** — optional guest user ID for public requests.
- **`GUEST_USER_EMAIL`** — fallback guest email used when a guest profile must be created automatically.

### RabbitMQ

- **`RABBITMQ_HTTP_URL`** — RabbitMQ HTTP Management API base URL.
- **`RABBITMQ_VHOST`** — RabbitMQ virtual host.
- **`RABBITMQ_AUTH_BASE64`** — base64-encoded Basic Auth credentials for the RabbitMQ HTTP API.

### Supabase

- **`SUPABASE_URL`** — Supabase project URL.
- **`SUPABASE_SERVICE_ROLE_KEY`** — service role key used by the backend.
- **`SUPABASE_ANON_KEY`** — public anonymous key exposed to the frontend.
- **`SUPABASE_JWT_SECRET`** — JWT secret used for token validation.

### Azure OpenAI

- **`AZURE_OPENAI_API_KEY`** — Azure OpenAI API key.
- **`AZURE_OPENAI_API_INSTANCE_NAME`** — Azure OpenAI instance name.
- **`AZURE_OPENAI_DEPLOYMENT_SCRIPT`** — deployment used for script generation. Defaults to `gpt-5`.
- **`AZURE_OPENAI_DEPLOYMENT_SQL`** — deployment used for structured reasoning tasks such as place selection and OSM name prediction. Defaults to `o3-mini`.
- **`AZURE_OPENAI_API_VERSION`** — Azure OpenAI API version.

### SMTP

- **`SMTP_HOST`** — SMTP host.
- **`SMTP_PORT`** — SMTP port.
- **`SMTP_USER`** — SMTP username.
- **`SMTP_PASS`** — SMTP password or app password.

## Installation

```bash
npm install
```

## Running locally

### Development mode

```bash
npm run dev
```

### Production mode

```bash
npm start
```

The application starts the HTTP server and the background worker in the same process.

## Docker Compose

Start the application and RabbitMQ together:

```bash
docker compose up --build
```

Exposed services from **`docker-compose.yml`**:

- Application: **`http://localhost:3000`**
- RabbitMQ AMQP port: **`localhost:5672`**
- RabbitMQ Management UI: **`http://localhost:15672`**

Note: the current Docker Compose file sets **`RABBITMQ_URL`**, while the application code reads RabbitMQ settings from **`RABBITMQ_HTTP_URL`**, **`RABBITMQ_VHOST`**, and **`RABBITMQ_AUTH_BASE64`**. If you rely on Docker Compose for local startup, make sure those variables are also provided through **`.env`** or compose overrides.

## API endpoints

### Public endpoints

- **`GET /api/public-config`** — returns frontend-safe Supabase configuration.
- **`POST /api/public-generate-script`** — accepts guest requests and starts background processing.

Required fields for **`POST /api/public-generate-script`**:

```json
{
  "hotel_website_url": "https://example-hotel.com",
  "business_goal": "Increase direct bookings for the summer season",
  "contact_email": "client@example.com",
  "city": "Paris",
  "language": "English",
  "country": "France",
  "guest_preference": "romantic city break"
}
```

### Authenticated endpoints

- **`POST /generate-script`** — creates a scenario for the authenticated user.
- **`POST /api/bulk-generate-script`** — processes multiple hotels in batches of three.
- **`GET /api/me/profile`** — returns the current user profile.
- **`PUT /api/me/profile`** — updates the current user profile.
- **`POST /api/me/avatar`** — uploads a base64 avatar image and stores its public URL.
- **`GET /api/me/scripts`** — returns the current user’s scenarios.
- **`GET /api/me/scripts/:id`** — returns a single scenario with related source data and discovered attractions.

Protected endpoints require a Supabase bearer token in the **`Authorization`** header.

## Background processing details

The worker in **`src/worker.js`** performs the following stages:

1. Create a scenario record with status `processing`.
2. Predict a cleaner canonical hotel name for OpenStreetMap lookup.
3. Resolve hotel coordinates and address data.
4. Search nearby public places using guest-preference-derived categories.
5. Fall back to a broader place search when the narrowed search returns no results.
6. Ask AI to choose the most relevant categories and places.
7. Save discovered attractions and hotel source data.
8. Generate the final script with Azure OpenAI.
9. Fall back to a structured script template if AI output is missing or invalid.
10. Save the final script, update scenario status, and send the result by email.

## Database model

The schema in **`supabase/schema.sql`** defines four main application tables:

- **`user_profiles`** — profile data linked to Supabase Auth users.
- **`hotel_scenarios`** — scenario records, statuses, selected categories, and final scripts.
- **`hotel_source_data`** — parsed hotel source data, coordinates, and attraction search metadata.
- **`hotel_discovered_attractions`** — discovered attraction category maps and selected attractions.

The schema also includes:

- indexes for common access patterns,
- `updated_at` triggers,
- row-level security policies for user-owned data.

## Frontend

Static frontend assets are served from the **`public`** directory:

- **`public/index.html`** — public entry page.
- **`public/dashboard.html`** — authenticated dashboard.

The backend also exposes **`GET /api/public-config`** so the frontend can initialize Supabase with public credentials.

## Operational notes

- RabbitMQ publishing is implemented through the HTTP Management API rather than AMQP client libraries.
- If RabbitMQ publishing fails, jobs are queued in memory and processed directly by the polling worker.
- Geocoding uses cached city coordinates and multiple fallback strategies.
- Script generation includes a strict structural validation step and a deterministic fallback template.
- Email delivery retries failed SMTP sends before surfacing an error.

## Known inconsistencies in the current codebase

These are implementation-level issues worth knowing about:

- **`package.json`** still uses the name `n8n-hotel-workflow-clone`, which does not match the product naming used elsewhere.
- **`src/ai.js`** references **`AZURE_OPENAI_ENDPOINT`** and **`AZURE_OPENAI_DEPLOYMENT`**, while **`src/config.js`** exports **`AZURE_OPENAI_API_INSTANCE_NAME`**, **`AZURE_OPENAI_DEPLOYMENT_SCRIPT`**, and **`AZURE_OPENAI_DEPLOYMENT_SQL`**. This should be aligned in code.
- The default language in **`supabase/schema.sql`** is `Russian`, while the application logic usually defaults to `English`.
- **`docker-compose.yml`** sets **`RABBITMQ_URL`**, but the application currently reads RabbitMQ configuration from different environment variables.
- **`src/db.js`** returns an avatar upload object containing `avatar_url`, while **`src/webhook.js`** stores the whole returned object as `avatar_url`; this likely needs normalization.

## Suggested next improvements

- Align Azure OpenAI configuration naming between **`src/config.js`** and **`src/ai.js`**.
- Align Docker Compose environment variables with the actual RabbitMQ configuration used by the app.
- Normalize avatar upload response handling.
- Add automated tests for API routes, worker logic, and fallback behavior.
- Split the worker into a separate deployable process if throughput grows.

## License

Private project. Usage and distribution depend on the repository owner’s policy.
