const express = require('express');
const path = require('path');
const webhookRoutes = require('./webhook');
const { startWorker } = require('./worker');
const config = require('./config');

const app = express();
app.use(express.json({ limit: '10mb' }));

app.get('/api/public-config', (req, res) => {
    res.json({
        supabaseUrl: config.SUPABASE_URL || '',
        supabaseAnonKey: config.SUPABASE_ANON_KEY || ''
    });
});

app.use(express.static(path.join(__dirname, '../public')));
app.use('/', webhookRoutes);

app.listen(config.PORT, () => {
    console.log(`Server listening on port ${config.PORT}`);
    startWorker();
});
