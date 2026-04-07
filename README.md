# Hotel Scenarios

Hotel Scenarios is a Node.js service that generates short-form hotel marketing scripts from a hotel website URL.

The application accepts requests from a public page or an authenticated dashboard, scrapes hotel website content, enriches the result with geolocation and nearby attractions, uses Azure OpenAI to select the most relevant local context, generates a 15-second script, stores the result in Supabase, and emails the finished script to the requester.

---

## Table of contents

- [Overview](#overview)
- [Key features](#key-features)
- [How it works](#how-it-works)
- [Architecture](#architecture)
- [Project structure](#project-structure)
- [Technology stack](#technology-stack)
- [Requirements](#requirements)
- [Environment variables](#environment-variables)
- [Getting started](#getting-started)
- [Running with Docker Compose](#running-with-docker-compose)
- [API reference](#api-reference)
- [Background worker pipeline](#background-worker-pipeline)
- [Database schema](#database-schema)
- [Frontend](#frontend)
- [Operational notes](#operational-notes)
- [Known implementation notes](#known-implementation-notes)
- [Recommended next improvements](#recommended-next-improvements)
- [License](#license)

---

## Overview

This project automates the full path from raw hotel website input to a ready-to-use short video script.

Typical use case:

1. A user submits a hotel website URL and campaign context.
2. The backend scrapes and extracts hotel information.
3. The worker resolves hotel location and nearby attractions.
4. AI selects the most relevant places for the target guest intent.
5. AI generates a short marketing script.
6. The result is saved and delivered by email.

The service is designed for both guest submissions and authenticated user workflows.

---

## Key features

- Public script generation flow.
- Authenticated script generation flow.
- Bulk processing for authenticated users.
- Background processing through RabbitMQ HTTP Management API.
- In-memory fallback queue when RabbitMQ is unavailable.
- Hotel website scraping through an external scraper service.
- Geocoding and nearby place discovery using OpenStreetMap services.
- Guest-preference-aware attraction filtering.
- AI-assisted place selection.
- AI-assisted 15-second script generation.
- Structured fallback script generation when AI output fails.
- Supabase persistence for profiles, scenarios, source data, and attractions.
- Static frontend pages for public and authenticated usage.
- Email delivery of completed scripts.
- Docker support for local startup.

---

## How it works

At a high level, the application follows this sequence:

1. The client sends a request to a public or authenticated endpoint.
2. The API validates the request and prepares a processing payload.
3. The hotel website is scraped through an external scraper endpoint.
4. Structured hotel information is extracted.
5. The payload is published to the queue layer.
6. The worker creates a scenario record in Supabase.
7. AI predicts a cleaner hotel name for map lookup.
8. The geolocation layer resolves coordinates and address details.
9. Nearby places are searched using guest-preference-derived categories.
10. If needed, the search falls back to broader categories.
11. AI selects the most relevant nearby places.
12. AI generates the final short-form script.
13. The result is stored in Supabase.
14. The final script is emailed to the requester.

---

## Architecture

The project runs as a single Express application with an internal worker loop.

### Main layers

- **HTTP layer** — receives requests, serves static files, and exposes API endpoints.
- **Preparation layer** — scrapes hotel websites and extracts structured hotel data.
- **Queue layer** — publishes jobs through RabbitMQ HTTP API and falls back to in-process execution when queue publishing is unavailable.
- **Worker layer** — enriches hotel data, selects attractions, generates scripts, persists results, and sends emails.
- **Data layer** — stores users, scenarios, source data, and discovered attractions in Supabase.
- **Frontend layer** — serves static pages from the `public` directory.

### Runtime entrypoints

- [`src/index.js`](src/index.js) starts the Express server, exposes [`GET /api/public-config`](src/index.js:10), serves static assets, mounts routes, and starts the worker.
- [`src/webhook.js`](src/webhook.js) contains public and authenticated API routes.
- [`src/worker.js`](src/worker.js) contains the background processing pipeline.

---

## Project structure

### Backend core

- [`src/index.js`](src/index.js) — Express bootstrap, JSON middleware, static file serving, public config endpoint, and worker startup.
- [`src/webhook.js`](src/webhook.js) — public and authenticated API routes, batch processing, profile endpoints, and avatar upload endpoint.
- [`src/worker.js`](src/worker.js) — scenario processing pipeline, geocoding, attraction discovery, AI generation, persistence, and email delivery.
- [`src/rabbitmq.js`](src/rabbitmq.js) — RabbitMQ HTTP publishing, polling consumer, and in-memory fallback queue.
- [`src/scraper.js`](src/scraper.js) — external scraper integration and hotel data extraction.
- [`src/geo.js`](src/geo.js) — city caching, geocoding, OpenStreetMap lookup, and nearby place discovery.
- [`src/placePreferences.js`](src/placePreferences.js) — guest preference parsing and attraction category definitions.
- [`src/ai.js`](src/ai.js) — Azure OpenAI integration, place selection, OSM name prediction, and script generation.
- [`src/db.js`](src/db.js) — Supabase persistence for scenarios, source data, attractions, profiles, and avatars.
- [`src/auth.js`](src/auth.js) — Supabase token validation middleware.
- [`src/email.js`](src/email.js) — SMTP transport creation and retry-based email delivery.
- [`src/config.js`](src/config.js) — environment variable loading and runtime configuration.
- [`src/logger.js`](src/logger.js) — logging helpers.

### Frontend

- [`public/index.html`](public/index.html) — public entry page.
- [`public/dashboard.html`](public/dashboard.html) — authenticated dashboard UI.

### Infrastructure and data

- [`supabase/schema.sql`](supabase/schema.sql) — database schema, indexes, triggers, and row-level security policies.
- [`Dockerfile`](Dockerfile) — application container definition.
- [`docker-compose.yml`](docker-compose.yml) — local multi-container setup.
- [`.env.example`](.env.example) — example environment configuration.
- [`city_cache.json`](city_cache.json) — cached city geolocation data.
- [`ny_hotels.json`](ny_hotels.json) and [`us_hotels_100.json`](us_hotels_100.json) — sample hotel datasets.

---

## Technology stack

- Node.js
- Express
- Axios
- Supabase
- RabbitMQ HTTP Management API
- Azure OpenAI
- Nodemailer
- Docker
- OpenStreetMap / Nominatim / Overpass

---

## Requirements

Before running the project, make sure you have:

- Node.js 18 or newer.
- npm.
- A Supabase project.
- RabbitMQ access through the HTTP Management API.
- Azure OpenAI credentials.
- SMTP credentials for outbound email delivery.
- Access to the external scraper service configured in the environment.

---

## Environment variables

Create a local [`.env`](.env) file based on [`.env.example`](.env.example).

The application reads configuration from [`src/config.js`](src/config.js:7).

### Server and scraping

- `PORT` — HTTP server port. Default: `3000`.
- `SCRAPER_API_URL` — external scraper endpoint used to fetch hotel website content.

### Guest-mode defaults

- `GUEST_USER_ID` — optional guest user ID for public requests.
- `GUEST_USER_EMAIL` — fallback guest email used when a guest profile must be created automatically.

### RabbitMQ

- `RABBITMQ_HTTP_URL` — RabbitMQ HTTP Management API base URL.
- `RABBITMQ_VHOST` — RabbitMQ virtual host.
- `RABBITMQ_AUTH_BASE64` — base64-encoded Basic Auth credentials for the RabbitMQ HTTP API.

### Supabase

- `SUPABASE_URL` — Supabase project URL.
- `SUPABASE_SERVICE_ROLE_KEY` — backend service role key.
- `SUPABASE_ANON_KEY` — public anonymous key exposed to the frontend.
- `SUPABASE_JWT_SECRET` — JWT secret used for token validation.

### Azure OpenAI

- `AZURE_OPENAI_API_KEY` — Azure OpenAI API key.
- `AZURE_OPENAI_API_INSTANCE_NAME` — Azure OpenAI instance name.
- `AZURE_OPENAI_ENDPOINT` — optional explicit endpoint. If omitted, it is derived in [`src/config.js`](src/config.js:3) from `AZURE_OPENAI_API_INSTANCE_NAME`.
- `AZURE_OPENAI_DEPLOYMENT_SCRIPT` — deployment used for script generation. Default: `gpt-5`.
- `AZURE_OPENAI_DEPLOYMENT_SQL` — deployment used for structured reasoning tasks such as place selection and OSM prediction. Default: `o3-mini`.
- `AZURE_OPENAI_API_VERSION` — Azure OpenAI API version.

### SMTP

- `SMTP_HOST` — SMTP host.
- `SMTP_PORT` — SMTP port.
- `SMTP_USER` — SMTP username.
- `SMTP_PASS` — SMTP password or app password.

### Example

```env
PORT=3000
SCRAPER_API_URL=https://your-scraper.example.com/scrape

GUEST_USER_ID=
GUEST_USER_EMAIL=guest@your-domain.com

RABBITMQ_HTTP_URL=https://rabbitmq.example.com
RABBITMQ_VHOST=hotels
RABBITMQ_AUTH_BASE64=base64(username:password)

SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
SUPABASE_ANON_KEY=your_anon_key
SUPABASE_JWT_SECRET=your_jwt_secret

AZURE_OPENAI_API_KEY=your_azure_openai_key
AZURE_OPENAI_API_INSTANCE_NAME=your_instance_name
AZURE_OPENAI_DEPLOYMENT_SCRIPT=gpt-5
AZURE_OPENAI_DEPLOYMENT_SQL=o3-mini
AZURE_OPENAI_API_VERSION=2025-03-01-preview

SMTP_HOST=smtp.example.com
SMTP_PORT=465
SMTP_USER=your_email@example.com
SMTP_PASS=your_password
```

---

## Getting started

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

Copy [`.env.example`](.env.example) to [`.env`](.env) and fill in the required values.

### 3. Prepare the database

Apply the schema from [`supabase/schema.sql`](supabase/schema.sql).

### 4. Start the application

#### Development mode

```bash
npm run dev
```

#### Production mode

```bash
npm start
```

The application starts the HTTP server and the background worker in the same process.

### 5. Open the UI

- Public page: `http://localhost:3000`
- Dashboard: `http://localhost:3000/dashboard.html`
- Public config endpoint: `http://localhost:3000/api/public-config`

---

## Running with Docker Compose

Start the application and RabbitMQ together:

```bash
docker compose up --build
```

Exposed services from [`docker-compose.yml`](docker-compose.yml):

- Application: `http://localhost:3000`
- RabbitMQ AMQP port: `localhost:5672`
- RabbitMQ Management UI: `http://localhost:15672`

### Important note

[`docker-compose.yml`](docker-compose.yml) currently sets `RABBITMQ_URL`, while the application code reads RabbitMQ settings from `RABBITMQ_HTTP_URL`, `RABBITMQ_VHOST`, and `RABBITMQ_AUTH_BASE64` in [`src/config.js`](src/config.js:13).

If you rely on Docker Compose for local startup, provide the actual RabbitMQ HTTP variables through [`.env`](.env) or update [`docker-compose.yml`](docker-compose.yml) to match the application configuration.

---

## API reference

### Public endpoints

- [`GET /api/public-config`](src/index.js:10) — returns frontend-safe Supabase configuration.
- [`POST /api/public-generate-script`](src/webhook.js:141) — accepts guest requests and starts background processing.

#### Required fields for public generation

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

- [`POST /generate-script`](src/webhook.js:122) — creates a scenario for the authenticated user.
- [`POST /api/bulk-generate-script`](src/webhook.js:181) — processes multiple hotels in batches.
- [`GET /api/me/profile`](src/webhook.js:235) — returns the current user profile.
- `PUT /api/me/profile` — updates the current user profile.
- `POST /api/me/avatar` — uploads a base64 avatar image and stores its public URL.
- `GET /api/me/scripts` — returns the current user’s scenarios.
- `GET /api/me/scripts/:id` — returns a single scenario with related source data and discovered attractions.

Protected endpoints require a Supabase bearer token in the `Authorization` header.

### Bulk processing behavior

The bulk endpoint currently processes unique hotels in batches of `2` with a `7000ms` pause between batches in [`src/webhook.js`](src/webhook.js:210).

---

## Background worker pipeline

The worker logic is implemented in [`src/worker.js`](src/worker.js:24).

Main stages:

1. Create a scenario record with status `processing`.
2. Predict a cleaner canonical hotel name for OpenStreetMap lookup.
3. Resolve hotel coordinates and address data.
4. Search nearby public places using guest-preference-derived categories.
5. Fall back to a broader place search when narrowed search returns no results.
6. Ask AI to choose the most relevant categories and places.
7. Save discovered attractions and hotel source data.
8. Generate the final script with Azure OpenAI.
9. Fall back to a structured script template if AI output is missing or invalid.
10. Save the final script, update scenario status, and send the result by email.

### Failure handling

- If scraping fails, the API continues with minimal hotel data in [`processSingleHotel()`](src/webhook.js:66).
- If RabbitMQ publishing fails, the queue layer falls back to in-memory processing.
- If AI script generation fails, [`buildStructuredFallbackScript()`](src/ai.js:166) is used.
- If email sending fails, the scenario can still complete successfully while the email error is logged.

---

## Database schema

The schema is defined in [`supabase/schema.sql`](supabase/schema.sql).

### Main tables

- `user_profiles` — profile data linked to Supabase Auth users.
- `hotel_scenarios` — scenario records, statuses, selected categories, and final scripts.
- `hotel_source_data` — parsed hotel source data, coordinates, and attraction search metadata.
- `hotel_discovered_attractions` — discovered attraction category maps and selected attractions.

### Additional schema behavior

- Indexes support common access patterns.
- `updated_at` triggers keep modification timestamps current.
- Row-level security policies restrict access to user-owned data.

### Important note

The default value for `language` in [`public.hotel_scenarios`](supabase/schema.sql:31) is currently `Russian`, while request handling in [`src/webhook.js`](src/webhook.js:145) and [`src/worker.js`](src/worker.js:40) usually defaults to `English`.

---

## Frontend

Static frontend assets are served from the [`public`](public) directory:

- [`public/index.html`](public/index.html) — public entry page.
- [`public/dashboard.html`](public/dashboard.html) — authenticated dashboard.

The backend also exposes [`GET /api/public-config`](src/index.js:10) so the frontend can initialize Supabase with public credentials.

---

## Operational notes

- RabbitMQ publishing is implemented through the HTTP Management API rather than AMQP client libraries.
- If queue publishing fails, jobs can still be processed through fallback logic.
- Geocoding uses cached city coordinates and multiple fallback strategies.
- Script generation includes structural validation and deterministic fallback behavior.
- Email delivery retries failed SMTP sends before surfacing an error.
- The server and worker currently run in the same Node.js process.

---

## Known implementation notes

These are not README issues, but real codebase details worth knowing before deployment or extension.

- [`package.json`](package.json:2) still uses the package name `n8n-hotel-workflow-clone`, which does not match the product naming used elsewhere.
- [`docker-compose.yml`](docker-compose.yml:24) sets `RABBITMQ_URL`, but the app reads `RABBITMQ_HTTP_URL`, `RABBITMQ_VHOST`, and `RABBITMQ_AUTH_BASE64`.
- [`supabase/schema.sql`](supabase/schema.sql:40) defaults scenario language to `Russian`, while most request handling defaults to `English`.
- Avatar upload handling should be reviewed because the return shape from [`src/db.js`](src/db.js) and the way it is stored in [`src/webhook.js`](src/webhook.js) may require normalization.

---

## Recommended next improvements

- Align Docker Compose environment variables with the actual RabbitMQ configuration used by the app.
- Normalize avatar upload response handling between [`src/db.js`](src/db.js) and [`src/webhook.js`](src/webhook.js).
- Add automated tests for API routes, worker logic, and fallback behavior.
- Split the worker into a separate deployable process if throughput grows.
- Add request validation schemas for public and authenticated endpoints.
- Add healthcheck and readiness endpoints for production deployment.

---

## License

Private project. Usage and distribution depend on the repository owner’s policy.
