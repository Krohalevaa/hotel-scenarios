const axios = require('axios');
const config = require('./config');
const logger = require('./logger');

// RabbitMQ HTTP Management API — exactly as in the original n8n workflow
const RABBITMQ_BASE = config.RABBITMQ_HTTP_URL;
const VHOST = config.RABBITMQ_VHOST;
const QUEUE_NAME = 'hotel_data_queue';
const EXCHANGE = 'amq.default';
const pendingFallbackJobs = [];
const DIRECT_PROCESSING_REASON = 'rabbitmq_http_api_unreliable';

function getAuthHeader() {
    return `Basic ${config.RABBITMQ_AUTH_BASE64}`;
}

function stringifyErrorPayload(payload) {
    if (!payload) return 'unknown';
    return typeof payload === 'string' ? payload : JSON.stringify(payload);
}

function enqueueFallbackJob(data, reason) {
    pendingFallbackJobs.push({
        data,
        reason,
        queuedAt: new Date().toISOString()
    });
    logger.debug(`Request added to the processing queue: ${data?.hotel_name || data?.hotel_website_url || 'unknown'}`);
}

function takeFallbackJob() {
    return pendingFallbackJobs.shift() || null;
}

/**
 * Ensure the queue exists before publishing (creates it if needed).
 */
async function declareQueue() {
    const url = `${RABBITMQ_BASE}/api/queues/${encodeURIComponent(VHOST)}/${QUEUE_NAME}`;
    try {
        await axios.put(url, { durable: true }, {
            headers: {
                Authorization: getAuthHeader(),
                'Content-Type': 'application/json'
            },
            timeout: 15000
        });
        logger.debug('Processing queue is ready');
    } catch (err) {
        if (err.response?.status !== 204) {
            logger.error(`Queue declare error: ${stringifyErrorPayload(err.response?.data || err.message)}`);
            throw err;
        }
        logger.debug('Processing queue already exists');
    }
}

/**
 * Publish a message to queue via HTTP API.
 * Mirrors n8n node "RabbitMQ: Publish"
 */
async function publishToQueue(data) {
    logger.info(`Sending request for processing: ${data?.hotel_name || data?.hotel_website_url || 'unknown'}`);

    try {
        await declareQueue();

        const url = `${RABBITMQ_BASE}/api/exchanges/${encodeURIComponent(VHOST)}/${EXCHANGE}/publish`;
        const body = {
            properties: { delivery_mode: 2 },
            routing_key: QUEUE_NAME,
            payload: JSON.stringify(data),
            payload_encoding: 'string'
        };

        logger.debug('Publishing request to queue');

        const response = await axios.post(url, body, {
            headers: {
                Authorization: getAuthHeader(),
                'Content-Type': 'application/json'
            },
            timeout: 15000
        });

        logger.debug(`Request accepted by queue: status=${response.status}, routed=${response.data?.routed}`);

        if (response.data?.routed !== true) {
            throw new Error(`RabbitMQ publish was accepted but not routed. Response: ${stringifyErrorPayload(response.data)}`);
        }

        logger.warn(`RabbitMQ publish succeeded, but for reliability we are also starting local processing without waiting for queue consumption: ${data.hotel_name || data.hotel_website_url || 'unknown'}`);
        enqueueFallbackJob(data, DIRECT_PROCESSING_REASON);

        return {
            queued: true,
            fallbackQueued: true
        };
    } catch (err) {
        const reason = `publish_error:${stringifyErrorPayload(err.response?.data || err.message)}`;
        enqueueFallbackJob(data, reason);
        logger.warn(`RabbitMQ could not be used reliably, processing directly instead: ${stringifyErrorPayload(err.response?.data || err.message)}`);
        return {
            queued: false,
            fallbackQueued: true,
            error: err
        };
    }
}

/**
 * Get and acknowledge one message via HTTP API.
 * Mirrors n8n node "RabbitMQ: Get Message"
 */
async function getOneMessage() {
    const url = `${RABBITMQ_BASE}/api/queues/${encodeURIComponent(VHOST)}/${QUEUE_NAME}/get`;
    const requestBodies = [
        { count: 1, ackmode: 'ack_requeue_false', encoding: 'auto' },
        { count: 1, ackmode: 'ack_requeue_false', encoding: 'auto', truncate: 50000 },
        { count: 1, ackmode: 'ack_requeue_false', encoding: 'auto', vhost: VHOST, name: QUEUE_NAME }
    ];

    for (let attempt = 0; attempt < requestBodies.length; attempt += 1) {
        const body = requestBodies[attempt];

        try {
            const response = await axios.post(url, body, {
                headers: {
                    Authorization: getAuthHeader(),
                    'Content-Type': 'application/json'
                },
                timeout: 15000
            });

            const messages = Array.isArray(response.data) ? response.data : [];
            const firstMessage = messages[0] || null;
            logger.debug(`RabbitMQ get response: status=${response.status}, messages=${messages.length}, vhost=${VHOST}, queue=${QUEUE_NAME}, attempt=${attempt + 1}, firstRoutingKey=${firstMessage?.routing_key || 'n/a'}, firstPayloadBytes=${firstMessage?.payload ? Buffer.byteLength(String(firstMessage.payload), 'utf8') : 0}`);

            if (messages.length === 0) {
                continue;
            }

            const payload = messages[0]?.payload;
            if (!payload) {
                logger.warn('Received an empty request from the queue');
                return null;
            }

            const parsed = JSON.parse(payload);
            logger.debug(`Received request for processing: ${parsed?.hotel_name || parsed?.hotel_website_url || 'unknown'}`);
            return parsed;
        } catch (err) {
            logger.debug(`Queue read failed, will retry later: ${stringifyErrorPayload(err.response?.data || err.message)}`);
        }
    }

    return null;
}

/**
 * Poll the queue every N seconds and call callback for each message.
 * Mirrors n8n node "Polling Interval (5s)"
 */
function consumeFromQueue(callback, intervalMs = 5000) {
    logger.debug(`Checking for new requests every ${intervalMs / 1000} sec`);

    async function poll() {
        const ts = new Date().toISOString();
        try {
            logger.debug(`[${ts}] Checking queue`);
            const data = await getOneMessage();
            const fallbackJob = !data ? takeFallbackJob() : null;
            const job = data || fallbackJob?.data || null;
            const source = data ? 'rabbitmq' : (fallbackJob ? `fallback:${fallbackJob.reason}` : 'none');
            logger.debug(`[${ts}] Poll result: job=${Boolean(job)}, source=${source}`);

            if (job) {
                logger.debug(`[${ts}] Starting processing: ${job.hotel_name || job.hotel_website_url}, source=${source}`);

                await callback(job);
                setTimeout(poll, 100);
            } else {
                logger.debug(`[${ts}] No new requests`);
                setTimeout(poll, intervalMs);
            }
        } catch (err) {
            logger.warn(`[${ts}] Failed to check queue: ${err.message}`);
            setTimeout(poll, intervalMs);
        }
    }

    poll();
}

module.exports = { publishToQueue, consumeFromQueue, getOneMessage };
