const nodemailer = require('nodemailer');
const config = require('./config');
const logger = require('./logger');

const transporter = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: parseInt(config.SMTP_PORT, 10),
    secure: config.SMTP_SECURE, // false for 587
    auth: {
        user: config.SMTP_USER,
        pass: config.SMTP_PASS,
    },
    tls: {
        rejectUnauthorized: false
    },
    connectionTimeout: 15000, // 15s
    greetingTimeout: 15000,   // 15s
});

async function sendEmail(to, subject, text, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
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
            logger.warn(`Email attempt ${i + 1} failed: ${error.message}`);
            if (isLastAttempt) {
                throw new Error(`Failed to send email to ${to} after ${retries} attempts.`);
            } else {
                await new Promise(resolve => setTimeout(resolve, 5000)); // 5s delay
            }
        }
    }
}

module.exports = { sendEmail };
