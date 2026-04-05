const nodemailer = require('nodemailer');
const config = require('./config');
const logger = require('./logger');

function buildTransportOptions() {
    const port = parseInt(config.SMTP_PORT, 10);
    const secure = config.SMTP_SECURE;

    return {
        host: config.SMTP_HOST,
        port,
        secure,
        requireTLS: !secure,
        auth: {
            user: config.SMTP_USER,
            pass: config.SMTP_PASS,
        },
        connectionTimeout: 15000,
        greetingTimeout: 15000,
        socketTimeout: 30000,
        tls: {
            servername: config.SMTP_HOST,
            minVersion: 'TLSv1.2',
            rejectUnauthorized: false
        }
    };
}

function isTimeoutError(error) {
    const code = String(error?.code || '').toUpperCase();
    const message = String(error?.message || '').toLowerCase();
    return code === 'ETIMEDOUT' || message.includes('timeout') || message.includes('greeting never received');
}

async function sendEmail(to, subject, text, retries = 3) {
    for (let i = 0; i < retries; i++) {
        const transporter = nodemailer.createTransport(buildTransportOptions());

        try {
            logger.info(`Email attempt ${i + 1}: host=${config.SMTP_HOST}, port=${config.SMTP_PORT}, secure=${config.SMTP_SECURE}, to=${to}`);
            await transporter.sendMail({
                from: config.SMTP_USER,
                to,
                subject,
                text,
            });
            logger.info(`Email sent to ${to}`);
            return;
        } catch (error) {
            const isLastAttempt = i === retries - 1;
            const errorCode = error.code || 'UNKNOWN';
            logger.warn(`Email attempt ${i + 1} failed: ${errorCode} ${error.message}`);

            try {
                transporter.close();
            } catch (_) {
                // ignore transporter close errors
            }

            if (isTimeoutError(error)) {
                logger.error(`SMTP connection to ${config.SMTP_HOST}:${config.SMTP_PORT} timed out. TCP port is reachable, but the SMTP/TLS handshake is not completing. This usually means the SMTP provider is blocking the connection, the credentials/app-password setup is invalid for this SMTP mode, or the network path is interfering with the SMTP session.`);
            }

            if (isLastAttempt) {
                throw new Error(`Failed to send email to ${to} after ${retries} attempts. Last error: ${errorCode} ${error.message}`);
            }

            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
}

module.exports = { sendEmail };
