const { supabase } = require('./db');
const logger = require('./logger');

async function requireAuth(req, res, next) {
    try {
        const authHeader = req.headers.authorization || '';
        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

        if (!token) {
            return res.status(401).json({ error: 'Authorization token is required.' });
        }

        const { data, error } = await supabase.auth.getUser(token);

        if (error || !data?.user) {
            logger.warn(`Auth failed: ${error?.message || 'User not found'}`);
            return res.status(401).json({ error: 'Invalid or expired token.' });
        }

        req.user = {
            id: data.user.id,
            email: data.user.email
        };

        next();
    } catch (error) {
        logger.error(`Auth middleware error: ${error.message}`);
        res.status(500).json({ error: 'Authentication failed.' });
    }
}

module.exports = {
    requireAuth
};
