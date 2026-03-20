const axios = require('axios');
const config = require('./config');
const logger = require('./logger');

// RabbitMQ HTTP Management API — exactly as in the original n8n workflow
const RABBITMQ_BASE = config.RABBITMQ_HTTP_URL;
const VHOST = config.RABBITMQ_VHOST;
const QUEUE_NAME = 'hotel_data_queue';
const EXCHANGE = 'amq.default';
const pendingFallbackJobs = [];

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
    logger.warn(`RabbitMQ fallback job queued for hotel="${data?.hotel_name || data?.hotel_website_url || 'unknown'}" reason="${reason}" pending=${pendingFallbackJobs.length}`);
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
        logger.info(`Queue "${QUEUE_NAME}" is ready. vhost=${VHOST}`);
    } catch (err) {
        if (err.response?.status !== 204) {
            logger.error(`Queue declare error: ${stringifyErrorPayload(err.response?.data || err.message)}`);
            throw err;
        }
        logger.info(`Queue "${QUEUE_NAME}" already exists. vhost=${VHOST}`);
    }
}

/**
 * Publish a message to queue via HTTP API.
 * Mirrors n8n node "RabbitMQ: Publish"
 */
async function publishToQueue(data) {
    logger.info(`publishToQueue start: hotel="${data?.hotel_name || data?.hotel_website_url || 'unknown'}", user=${data?.user_id || 'n/a'}, hasEmail=${Boolean(data?.contact_email)}, hasGoal=${Boolean(data?.business_goal)}, city=${data?.city || 'n/a'}`);
    await declareQueue();

    const url = `${RABBITMQ_BASE}/api/exchanges/${encodeURIComponent(VHOST)}/${EXCHANGE}/publish`;
    const body = {
        properties: { delivery_mode: 2 },
        routing_key: QUEUE_NAME,
        payload: JSON.stringify(data),
        payload_encoding: 'string'
    };

    logger.info(`Publishing to RabbitMQ: hotel="${data?.hotel_name || data?.hotel_website_url}", vhost=${VHOST}, queue=${QUEUE_NAME}, exchange=${EXCHANGE}`);

    try {
        const response = await axios.post(url, body, {
            headers: {
                Authorization: getAuthHeader(),
                'Content-Type': 'application/json'
            },
            timeout: 15000
        });

        logger.info(`RabbitMQ publish response: status=${response.status}, routed=${response.data?.routed}, vhost=${VHOST}, queue=${QUEUE_NAME}`);

        if (response.data?.routed !== true) {
            const reason = `publish_not_routed:${stringifyErrorPayload(response.data)}`;
            enqueueFallbackJob(data, reason);
            throw new Error(`RabbitMQ publish was accepted but not routed. Response: ${stringifyErrorPayload(response.data)}`);
        }

        logger.warn(`RabbitMQ HTTP publish reported success, but HTTP API polling does not return the message. Processing job via in-process fallback to avoid data loss.`);
        enqueueFallbackJob(data, 'http_api_publish_without_readback');

        logger.info(`Published to RabbitMQ: ${data.hotel_name}`);
        return {
            queued: true,
            fallbackQueued: true
        };
    } catch (err) {
        const reason = `publish_error:${stringifyErrorPayload(err.response?.data || err.message)}`;
        enqueueFallbackJob(data, reason);
        logger.error(`RabbitMQ publish error: ${stringifyErrorPayload(err.response?.data || err.message)}`);
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
            logger.debug(`RabbitMQ get response: status=${response.status}, messages=${messages.length}, vhost=${VHOST}, queue=${QUEUE_NAME}, attempt=${attempt + 1}`);

            if (messages.length === 0) {
                continue;
            }

            const payload = messages[0]?.payload;
            if (!payload) {
                logger.warn('RabbitMQ returned a message without payload.');
                return null;
            }

            const parsed = JSON.parse(payload);
            logger.info(`RabbitMQ delivered message for hotel="${parsed?.hotel_name || parsed?.hotel_website_url || 'unknown'}"`);
            return parsed;
        } catch (err) {
            logger.error(`RabbitMQ get error on attempt ${attempt + 1}: ${stringifyErrorPayload(err.response?.data || err.message)}`);
        }
    }

    return null;
}

/**
 * Poll the queue every N seconds and call callback for each message.
 * Mirrors n8n node "Polling Interval (30s)"
 */
function consumeFromQueue(callback, intervalMs = 30000) {
    logger.info(`Worker polling queue "${QUEUE_NAME}" every ${intervalMs / 1000}s via HTTP API`);
    logger.info(`RabbitMQ consumer configuration: base=${RABBITMQ_BASE}, vhost=${VHOST}, queue=${QUEUE_NAME}, authConfigured=${Boolean(config.RABBITMQ_AUTH_BASE64)}`);

    async function poll() {
        const ts = new Date().toISOString();
        try {
            logger.info(`[${ts}] Polling queue...`);
            const data = await getOneMessage();
            const fallbackJob = !data ? takeFallbackJob() : null;
            const job = data || fallbackJob?.data || null;
            logger.debug(`[${ts}] Poll result: rabbitMessage=${Boolean(data)}, fallbackJob=${Boolean(fallbackJob)}, pendingFallback=${pendingFallbackJobs.length}`);

            if (job) {
                if (fallbackJob) {
                    logger.warn(`[${ts}] Processing fallback job directly for hotel="${job.hotel_name || job.hotel_website_url}" reason="${fallbackJob.reason}" queuedAt=${fallbackJob.queuedAt}`);
                } else {
                    logger.info(`[${ts}] Got message for hotel: ${job.hotel_name}`);
                }

                await callback(job);
                setTimeout(poll, 100);
            } else {
                logger.info(`[${ts}] Queue is empty or no message returned.`);
                setTimeout(poll, intervalMs);
            }
        } catch (err) {
            logger.error(`[${ts}] Poll error: ${err.message}`);
            setTimeout(poll, intervalMs);
        }
    }

    poll();
}

module.exports = { publishToQueue, consumeFromQueue, getOneMessage };
