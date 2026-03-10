const express = require('express');
const path = require('path');
const webhookRoutes = require('./webhook');
const { startWorker } = require('./worker');
const config = require('./config');

const app = express();
app.use(express.json());

// Serve static files from the public folder
app.use(express.static(path.join(__dirname, '../public')));

// Routes for webhooks
app.use('/', webhookRoutes);

app.listen(config.PORT, () => {
    console.log(`Server listening on port ${config.PORT}`);
    // Start the background worker process processing RMQ messages
    startWorker();
});
