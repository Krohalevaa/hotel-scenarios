const axios = require('axios');
const config = require('./config');

// RabbitMQ HTTP Management API — exactly as in the original n8n workflow
const RABBITMQ_BASE = config.RABBITMQ_HTTP_URL;
const VHOST = config.RABBITMQ_VHOST;
const QUEUE_NAME = 'hotel_data_queue';
const EXCHANGE = 'amq.default';

function getAuthHeader() {
    return `Basic ${config.RABBITMQ_AUTH_BASE64}`;
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
            }
        });
        console.log(`Queue "${QUEUE_NAME}" is ready.`);
    } catch (err) {
        // 204 No Content = already exists — that's OK
        if (err.response?.status !== 204) {
            console.error('Queue declare error:', err.response?.data || err.message);
        }
    }
}

/**
 * Publish a message to queue via HTTP API.
 * Mirrors n8n node "RabbitMQ: Publish"
 */
async function publishToQueue(data) {
    // Make sure queue exists first
    await declareQueue();

    const url = `${RABBITMQ_BASE}/api/exchanges/${encodeURIComponent(VHOST)}/${EXCHANGE}/publish`;
    const body = {
        properties: { delivery_mode: 2 },
        routing_key: QUEUE_NAME,
        payload: JSON.stringify(data),
        payload_encoding: 'string'
    };
    try {
        const response = await axios.post(url, body, {
            headers: {
                Authorization: getAuthHeader(),
                'Content-Type': 'application/json'
            }
        });
        if (response.data?.routed === false) {
            console.warn('WARNING: Message was NOT routed to any queue! Check vhost/queue config.');
        } else {
            console.log('Published to RabbitMQ:', data.hotel_name);
        }
    } catch (err) {
        console.error('RabbitMQ publish error:', err.response?.data || err.message);
        throw err;
    }
}

/**
 * Get and acknowledge one message via HTTP API.
 * Mirrors n8n node "RabbitMQ: Get Message"
 */
async function getOneMessage() {
    const url = `${RABBITMQ_BASE}/api/queues/${encodeURIComponent(VHOST)}/${QUEUE_NAME}/get`;
    const body = { count: 1, ackmode: 'ack_requeue_false', encoding: 'auto' };
    try {
        const response = await axios.post(url, body, {
            headers: {
                Authorization: getAuthHeader(),
                'Content-Type': 'application/json'
            }
        });
        const messages = response.data;
        if (!messages || messages.length === 0) return null;
        return JSON.parse(messages[0].payload);
    } catch (err) {
        console.error('RabbitMQ get error:', err.response?.data || err.message);
        return null;
    }
}

/**
 * Poll the queue every N seconds and call callback for each message.
 * Mirrors n8n node "Polling Interval (30s)"
 */
function consumeFromQueue(callback, intervalMs = 30000) {
    console.log(`Worker polling queue "${QUEUE_NAME}" every ${intervalMs / 1000}s via HTTP API`);

    async function poll() {
        const ts = new Date().toISOString();
        try {
            console.log(`[${ts}] Polling queue...`);
            const data = await getOneMessage();
            if (data) {
                console.log(`[${ts}] Got message for hotel:`, data.hotel_name);
                await callback(data);
            } else {
                console.log(`[${ts}] Queue is empty or no message returned.`);
            }
        } catch (err) {
            console.error(`[${ts}] Poll error:`, err.message);
        } finally {
            setTimeout(poll, intervalMs);
        }
    }

    // Start polling
    poll();
}

module.exports = { publishToQueue, consumeFromQueue, getOneMessage };
