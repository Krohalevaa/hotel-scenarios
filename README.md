# Hotel Scenarios

AI-powered hotel scenario generation platform built with Node.js, Express, RabbitMQ, Supabase, and Azure OpenAI.

It accepts hotel website data, enriches it with geolocation and nearby attractions, generates a tailored video script, stores the scenario in Supabase, and delivers the final result by email.

## Overview

Hotel Scenarios automates the full pipeline required to turn a hotel website into a ready-to-use marketing scenario:

1. Receive a hotel request from an authenticated dashboard or a public endpoint.
2. Scrape and extract hotel information from the provided website.
3. Queue the job for background processing with RabbitMQ.
4. Resolve hotel coordinates and discover nearby public places.
5. Use AI to select the most relevant attractions.
6. Generate a final hotel-focused script in the requested language.
7. Save the scenario and related source data in Supabase.
8. Send the completed script to the target email address.

## Key Features

- End-to-end hotel scenario generation workflow.
- Background job processing with RabbitMQ.
- Website scraping and hotel data extraction.
- Geolocation lookup and nearby attraction discovery.
- AI-assisted attraction selection and script generation.
- Supabase-backed authentication, profiles, and scenario storage.
- Public and authenticated API flows.
- Built-in dashboard served from the same Express application.
- Email delivery for completed scripts.
- Docker support for local deployment.

## Architecture

The application is organized as a single Node.js service with an internal worker pipeline:

- **API layer** handles incoming requests, authentication, and static frontend delivery.
- **Queue layer** decouples request intake from long-running processing.
- **Worker layer** performs scraping, enrichment, AI generation, persistence, and email delivery.
- **Data layer** stores users, profiles, scenarios, and attraction-related records in Supabase.
- **Frontend layer** provides a dashboard for authenticated users.

## Request Flow

1. A client submits a request to an API endpoint.
2. The server validates the payload and user context.
3. The hotel request is scraped and normalized.
4. The job is published to RabbitMQ.
5. The worker consumes the job and creates a scenario record.
6. The worker resolves coordinates and searches for nearby places.
7. AI selects the most relevant places and generates the final script.
8. The result is saved in Supabase and emailed to the requester.

## Project Structure

- **`src/index.js`** — application entry point, Express bootstrap, static file hosting, and worker startup.
- **`src/config.js`** — environment variable loading and runtime configuration.
- **`src/webhook.js`** — API routes for public and authenticated scenario generation, profile access, and script retrieval.
- **`src/auth.js`** — Supabase token validation middleware.
- **`src/scraper.js`** — hotel website scraping and structured data extraction.
- **`src/rabbitmq.js`** — queue publishing and consumer setup.
- **`src/geo.js`** — coordinate lookup and nearby place discovery.
- **`src/placePreferences.js`** — guest preference parsing and attraction category selection helpers.
- **`src/ai.js`** — Azure OpenAI integration for hotel enrichment, place selection, and script generation.
- **`src/db.js`** — Supabase access layer for scenarios, profiles, and related records.
- **`src/email.js`** — SMTP email delivery.
- **`src/logger.js`** — application logging utilities.
- **`src/worker.js`** — background processing pipeline.
- **`public/index.html`** — public landing page.
- **`public/dashboard.html`** — authenticated dashboard UI.
- **`supabase/schema.sql`** — database schema for Supabase.
- **`docker-compose.yml`** — local multi-service setup with RabbitMQ and the app container.
- **`Dockerfile`** — container image definition for the application.

## Tech Stack

- Node.js
- Express
- RabbitMQ
- Supabase
- Azure OpenAI via LangChain
- Nodemailer
- Docker / Docker Compose

## Prerequisites

Before running the project, make sure you have:

- Node.js 18+ installed.
- npm available.
- A running RabbitMQ instance.
- A Supabase project with the required schema.
- Azure OpenAI credentials.
- SMTP credentials for outbound email delivery.

## Environment Variables

Create a local **`.env`** file based on **`.env.example`**.

Core variables used by the project include:

- **`PORT`** — HTTP server port.
- **`SCRAPER_API_URL`** — external scraping service endpoint.
- **`GUEST_USER_ID`** / **`GUEST_USER_EMAIL`** — guest-mode fallback identity.
- **`RABBITMQ_HTTP_URL`**, **`RABBITMQ_VHOST`**, **`RABBITMQ_AUTH_BASE64`** — RabbitMQ connection and management settings.
- **`SUPABASE_URL`**, **`SUPABASE_SERVICE_ROLE_KEY`**, **`SUPABASE_ANON_KEY`**, **`SUPABASE_JWT_SECRET`** — Supabase configuration.
- **`AZURE_OPENAI_API_KEY`**, **`AZURE_OPENAI_API_INSTANCE_NAME`**, **`AZURE_OPENAI_DEPLOYMENT_SCRIPT`**, **`AZURE_OPENAI_DEPLOYMENT_SQL`**, **`AZURE_OPENAI_API_VERSION`** — Azure OpenAI configuration.
- **`SMTP_HOST`**, **`SMTP_PORT`**, **`SMTP_USER`**, **`SMTP_PASS`** — email transport settings.

## Installation

```bash
npm install
```

## Running Locally

### Development mode

```bash
npm run dev
```

### Production mode

```bash
npm start
```

The server starts on the configured port and also launches the background worker from the same process.

## Running with Docker Compose

Start the application and RabbitMQ together:

```bash
docker compose up --build
```

Default exposed services:

- Application: **`http://localhost:3000`**
- RabbitMQ AMQP: **`localhost:5672`**
- RabbitMQ Management UI: **`http://localhost:15672`**

## API Endpoints

### Public configuration

- **`GET /api/public-config`** — returns public Supabase configuration for the frontend.

### Public scenario generation

- **`POST /api/public-generate-script`** — accepts guest requests without authentication.

Required payload fields:

```json
{
  "hotel_website_url": "https://example-hotel.com",
  "business_goal": "Increase direct bookings for the summer season",
  "contact_email": "client@example.com",
  "city": "Paris",
  "language": "English",
  "country": "France"
}
```

### Authenticated scenario generation

- **`POST /generate-script`** — creates a scenario for the authenticated user.
- **`POST /api/bulk-generate-script`** — processes multiple hotels in batches.

### User profile and scripts

- **`GET /api/me/profile`** — returns the current user profile.
- **`GET /api/me/scripts`** — returns the current user’s scenarios.
- **`GET /api/me/scripts/:id`** — returns a single scenario by ID.

Authenticated endpoints require a Supabase bearer token in the **`Authorization`** header.

## Processing Pipeline

The background worker in **`src/worker.js`** follows a structured six-step flow:

1. Create a scenario record.
2. Predict and resolve hotel coordinates.
3. Search for nearby attractions.
4. Select relevant places based on guest preferences.
5. Generate the final script with AI or a structured fallback.
6. Save the result and send it by email.

This design keeps the HTTP layer responsive while long-running enrichment and generation tasks execute asynchronously.

## Frontend

The project serves static frontend assets from the **`public`** directory:

- **`public/index.html`** provides the public-facing entry page.
- **`public/dashboard.html`** provides the authenticated dashboard experience.

## Database

Supabase is used for:

- authentication,
- user profiles,
- scenario records,
- discovered attractions,
- hotel source data,
- generated script storage.

Apply the schema from **`supabase/schema.sql`** before using the application in a fresh environment.

## Logging and Operations

The service logs request intake, worker progress, AI generation status, and email delivery outcomes. This makes it easier to monitor batch processing and diagnose failures in scraping, enrichment, or outbound communication.

## Example Use Cases

- Generate personalized hotel marketing scripts from a single website.
- Process hotel lists in batches for agencies or internal teams.
- Combine guest preferences with nearby attractions to create more relevant scenario narratives.
- Power a lightweight internal dashboard for hospitality content operations.

## Future Improvement Ideas

- Add automated tests for API routes and worker logic.
- Separate the worker into an independent deployable service.
- Add retry policies and dead-letter queues for failed jobs.
- Introduce observability with metrics and tracing.
- Add role-based access control in the dashboard.
- Support more delivery channels beyond email.

## License

Private project. Use and distribution depend on the repository owner’s policy.
