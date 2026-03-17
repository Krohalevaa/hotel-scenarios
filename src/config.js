require('dotenv').config();

module.exports = {
  PORT: process.env.PORT || 3000,
  SCRAPER_API_URL: process.env.SCRAPER_API_URL || "https://kondratmeech.orangepebble-c36ec136.eastus2.azurecontainerapps.io/scrape",

  // RabbitMQ via HTTP Management API (no AMQP/TLS needed)
  RABBITMQ_HTTP_URL: process.env.RABBITMQ_HTTP_URL || "https://rabbitmq-app.orangepebble-c36ec136.eastus2.azurecontainerapps.io",
  RABBITMQ_VHOST: process.env.RABBITMQ_VHOST || "hotels",
  RABBITMQ_AUTH_BASE64: process.env.RABBITMQ_AUTH_BASE64 || "",

  CLICKHOUSE_URL: process.env.CLICKHOUSE_URL || "https://clickhouse-db.orangepebble-c36ec136.eastus2.azurecontainerapps.io:443",
  CLICKHOUSE_AUTH_BASE64: process.env.CLICKHOUSE_AUTH_BASE64 || "",
  AZURE_OPENAI_API_KEY: process.env.AZURE_OPENAI_API_KEY,
  AZURE_OPENAI_API_INSTANCE_NAME: process.env.AZURE_OPENAI_API_INSTANCE_NAME,
  // Two deployments matching original n8n workflow
  AZURE_OPENAI_DEPLOYMENT_SCRIPT: process.env.AZURE_OPENAI_DEPLOYMENT_SCRIPT || 'gpt-5',
  AZURE_OPENAI_DEPLOYMENT_SQL: process.env.AZURE_OPENAI_DEPLOYMENT_SQL || 'o3-mini',
  AZURE_OPENAI_API_VERSION: process.env.AZURE_OPENAI_API_VERSION,
  SMTP_HOST: process.env.SMTP_HOST || "smtp.yandex.ru",
  SMTP_PORT: process.env.SMTP_PORT || 587,
  SMTP_SECURE: process.env.SMTP_PORT === "465",
  SMTP_USER: process.env.SMTP_USER || "anyakrohalevaa@yandex.ru",
  SMTP_PASS: process.env.SMTP_PASS || ""
};
