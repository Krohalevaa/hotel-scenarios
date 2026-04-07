require('dotenv').config();

const azureInstanceName = process.env.AZURE_OPENAI_API_INSTANCE_NAME || '';
const azureEndpoint = process.env.AZURE_OPENAI_ENDPOINT
  || (azureInstanceName ? `https://${azureInstanceName}.openai.azure.com` : '');

module.exports = {
  PORT: process.env.PORT || 3000,
  SCRAPER_API_URL: process.env.SCRAPER_API_URL || 'https://kondratmeech.orangepebble-c36ec136.eastus2.azurecontainerapps.io/scrape',
  GUEST_USER_ID: process.env.GUEST_USER_ID || '',
  GUEST_USER_EMAIL: process.env.GUEST_USER_EMAIL || 'guest@hotel-scenarios.local',

  // RabbitMQ via HTTP Management API (no AMQP/TLS needed)
  RABBITMQ_HTTP_URL: process.env.RABBITMQ_HTTP_URL || 'https://rabbitmq-app.orangepebble-c36ec136.eastus2.azurecontainerapps.io',
  RABBITMQ_VHOST: process.env.RABBITMQ_VHOST || 'hotels',
  RABBITMQ_AUTH_BASE64: process.env.RABBITMQ_AUTH_BASE64 || '',

  SUPABASE_URL: process.env.SUPABASE_URL || '',
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY || '',
  SUPABASE_JWT_SECRET: process.env.SUPABASE_JWT_SECRET || '',

  AZURE_OPENAI_API_KEY: process.env.AZURE_OPENAI_API_KEY,
  AZURE_OPENAI_API_INSTANCE_NAME: azureInstanceName,
  AZURE_OPENAI_ENDPOINT: azureEndpoint,
  AZURE_OPENAI_DEPLOYMENT_SCRIPT: process.env.AZURE_OPENAI_DEPLOYMENT_SCRIPT || 'gpt-5',
  AZURE_OPENAI_DEPLOYMENT_SQL: process.env.AZURE_OPENAI_DEPLOYMENT_SQL || 'o3-mini',
  AZURE_OPENAI_API_VERSION: process.env.AZURE_OPENAI_API_VERSION || '2025-03-01-preview',

  SMTP_HOST: process.env.SMTP_HOST || 'smtp.yandex.ru',
  SMTP_PORT: process.env.SMTP_PORT || 587,
  SMTP_SECURE: process.env.SMTP_PORT === '465',
  SMTP_USER: process.env.SMTP_USER || 'anyakrohalevaa@yandex.ru',
  SMTP_PASS: process.env.SMTP_PASS || ''
};
