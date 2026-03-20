const fs = require('fs');
const path = require('path');

const logFile = path.join(__dirname, '../app.log');

// Task 9: Use write stream for better performance (non-blocking)
const logStream = fs.createWriteStream(logFile, { flags: 'a' });

function log(message, level = 'INFO') {
    const timestamp = new Date().toISOString();
    const formattedMessage = `[${timestamp}] [${level}] ${message}`;

    // Log to terminal
    console.log(formattedMessage);

    // Log to file (asynchronous)
    logStream.write(formattedMessage + '\n');
}

module.exports = {
    info: (msg) => log(msg, 'INFO'),
    error: (msg) => log(msg, 'ERROR'),
    warn: (msg) => log(msg, 'WARN'),
    debug: (msg) => log(msg, 'DEBUG')
};
