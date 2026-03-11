const fs = require('fs');
const path = require('path');

const logFile = path.join(__dirname, '../app.log');

function log(message, level = 'INFO') {
    const timestamp = new Date().toISOString();
    const formattedMessage = `[${timestamp}] [${level}] ${message}`;

    // Log to terminal
    console.log(formattedMessage);

    // Log to file
    try {
        fs.appendFileSync(logFile, formattedMessage + '\n');
    } catch (err) {
        console.error('Failed to write to log file:', err.message);
    }
}

module.exports = {
    info: (msg) => log(msg, 'INFO'),
    error: (msg) => log(msg, 'ERROR'),
    warn: (msg) => log(msg, 'WARN'),
    debug: (msg) => log(msg, 'DEBUG')
};
