const express = require('express');
const { scrapeHotelWebsite, extractHotelInfo } = require('./scraper');
const { publishToQueue } = require('./rabbitmq');
const { requireAuth } = require('./auth');
const db = require('./db');
const logger = require('./logger');
const config = require('./config');

const router = express.Router();
const recentSubmissionCache = new Map();
const RECENT_SUBMISSION_TTL_MS = 1000 * 60 * 1;

function buildSubmissionKey(hotelRequest = {}, userId = '') {
    return JSON.stringify({
        userId: userId || hotelRequest.user_id || '',
        hotel_website_url: String(hotelRequest.hotel_website_url || '').trim().toLowerCase(),
        city: String(hotelRequest.city || '').trim().toLowerCase(),
        business_goal: String(hotelRequest.business_goal || '').trim().toLowerCase(),
        guest_preference: String(hotelRequest.guest_preference || '').trim().toLowerCase(),
        language: String(hotelRequest.language || 'English').trim().toLowerCase()
    });
}

function isDuplicateRecentSubmission(hotelRequest = {}, userId = '') {
    const key = buildSubmissionKey(hotelRequest, userId);
    const now = Date.now();

    for (const [cacheKey, createdAt] of recentSubmissionCache.entries()) {
        if (now - createdAt > RECENT_SUBMISSION_TTL_MS) {
            recentSubmissionCache.delete(cacheKey);
        }
    }

    const existing = recentSubmissionCache.get(key);
    if (existing && now - existing <= RECENT_SUBMISSION_TTL_MS) {
        return true;
    }

    recentSubmissionCache.set(key, now);
    return false;
}

function parseBase64Image(dataUrl) {
    const match = /^data:(.+);base64,(.+)$/.exec(dataUrl || '');
    if (!match) {
        throw new Error('Avatar must be a valid base64 data URL.');
    }

    return {
        contentType: match[1],
        buffer: Buffer.from(match[2], 'base64')
    };
}

function splitFullName(fullName) {
    const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
    return {
        first_name: parts[0] || null,
        last_name: parts.slice(1).join(' ') || null
    };
}

/**
 * Helper to process a single hotel (Scrape -> Extract -> Queue)
 */
async function processSingleHotel(hotelRequest) {
    if (isDuplicateRecentSubmission(hotelRequest, hotelRequest.user_id)) {
        logger.warn(`Skipping duplicate hotel submission for ${hotelRequest.hotel_website_url}`);
        return;
    }
    const context = {
        request_id: Date.now().toString() + Math.random().toString(16).slice(2),
        created_at: new Date().toISOString(),
        hotel_website_url: hotelRequest.hotel_website_url,
        business_goal: hotelRequest.business_goal,
        guest_preference: hotelRequest.guest_preference || '',
        contact_email: hotelRequest.contact_email,
        city: hotelRequest.city,
        country: hotelRequest.country || null,
        hotel_context: '',
        status: 'new',
        language: hotelRequest.language || 'English',
        user_id: hotelRequest.user_id
    };

    let hotelData;
    try {
        logger.info(`Received hotel website: ${context.hotel_website_url}`);
        const rawData = await scrapeHotelWebsite(context.hotel_website_url);
        hotelData = extractHotelInfo(rawData, context);
        hotelData.user_id = context.user_id;
        hotelData.contact_email = context.contact_email;
        hotelData.business_goal = context.business_goal;
        hotelData.guest_preference = context.guest_preference;
        hotelData.city = context.city;
        hotelData.language = context.language;
        hotelData.country = context.country || hotelData.country || null;
        hotelData.hotel_website_url = context.hotel_website_url;
    } catch (e) {
        logger.warn(`Failed to read website, continuing with minimal data: ${e.message}`);
        const domain = new URL(context.hotel_website_url).hostname.replace('www.', '');
        hotelData = {
            hotel_name: domain,
            description: 'Website could not be scraped. Processing with minimal info.',
            city: context.city,
            hotel_website_url: context.hotel_website_url,
            contact_email: context.contact_email,
            business_goal: context.business_goal,
            guest_preference: context.guest_preference,
            language: context.language,
            country: context.country || null,
            user_id: context.user_id,
            amenities: [],
            special_offers: []
        };
    }

    await publishToQueue(hotelData);
    logger.info(`Request queued for processing: ${context.hotel_website_url}`);
}

router.post('/generate-script', requireAuth, async (req, res) => {
    const payload = {
        ...req.body,
        user_id: req.user.id,
        contact_email: req.body.contact_email || req.user.email
    };

    logger.info(`New user request: ${payload.hotel_website_url}`);

    res.json({
        status: 'success',
        message: 'Request received. Please check your email shortly.'
    });

    processSingleHotel(payload).catch((error) => {
        logger.error(`Background processing error: ${error.message}`);
    });
});

router.post('/api/public-generate-script', async (req, res) => {
    const payload = {
        ...req.body,
        contact_email: req.body.contact_email,
        language: req.body.language || 'English',
        country: req.body.country || null
    };

    if (!payload.hotel_website_url || !payload.business_goal || !payload.city || !payload.contact_email) {
        return res.status(400).json({ error: 'hotel_website_url, business_goal, city, and contact_email are required.' });
    }

    let guestUserId = config.GUEST_USER_ID;

    if (!guestUserId) {
        const guestEmail = config.GUEST_USER_EMAIL || payload.contact_email || 'guest@hotel-scenarios.local';
        const guestName = guestEmail.split('@')[0] || 'Guest';
        const guestProfile = await db.upsertProfile(guestEmail, {
            first_name: guestName,
            last_name: 'Guest',
            email: guestEmail
        });
        guestUserId = guestProfile.user_id;
        logger.warn(`Guest profile created automatically: ${guestEmail}`);
    }

    payload.user_id = guestUserId;

    logger.info(`New guest request: ${payload.hotel_website_url}`);

    res.json({
        status: 'success',
        message: 'Request received. We will send the script to your email.'
    });

    processSingleHotel(payload).catch((error) => {
        logger.error(`Guest background processing error: ${error.message}`);
    });
});

router.post('/api/bulk-generate-script', requireAuth, async (req, res) => {
    const hotels = Array.isArray(req.body) ? req.body : req.body?.hotels;
    if (!hotels || !Array.isArray(hotels)) {
        return res.status(400).json({ error: 'Expected an array of hotels.' });
    }

    const normalizedHotels = hotels.filter((hotel) => hotel?.hotel_website_url);
    const uniqueHotels = [];
    const seenKeys = new Set();

    for (const hotel of normalizedHotels) {
        const dedupeKey = buildSubmissionKey({
            ...hotel,
            language: hotel.language || 'English'
        }, req.user.id);

        if (seenKeys.has(dedupeKey)) {
            logger.warn(`Skipping duplicate hotel within bulk payload: ${hotel.hotel_website_url}`);
            continue;
        }

        seenKeys.add(dedupeKey);
        uniqueHotels.push(hotel);
    }

    logger.info(`Received request batch: ${hotels.length}, unique after dedupe: ${uniqueHotels.length}`);

    res.json({ message: `Started processing ${uniqueHotels.length} hotels in batches. Check logs for progress.` });

    const BATCH_SIZE = 2;
    (async () => {
        for (let i = 0; i < uniqueHotels.length; i += BATCH_SIZE) {
            const batch = uniqueHotels.slice(i, i + BATCH_SIZE);
            logger.info(`Processing batch ${Math.floor(i / BATCH_SIZE) + 1}: ${batch.length} hotels`);

            for (const hotel of batch) {
                try {
                    await processSingleHotel({
                        ...hotel,
                        user_id: req.user.id,
                        contact_email: hotel.contact_email || req.user.email
                    });
                } catch (err) {
                    logger.error(`Error in one of the batch hotels: ${err.message}`);
                }
            }

            if (i + BATCH_SIZE < uniqueHotels.length) {
                await new Promise((resolve) => setTimeout(resolve, 7000));
            }
        }
    })();
});

router.get('/api/me/profile', requireAuth, async (req, res) => {
    try {
        const profile = await db.getProfile(req.user.id);
        res.json({
            data: profile
                ? {
                    ...profile,
                    full_name: [profile.first_name, profile.last_name].filter(Boolean).join(' ').trim()
                }
                : {
                    first_name: null,
                    last_name: null,
                    full_name: '',
                    email: req.user.email,
                    avatar_url: null
                }
        });
    } catch (error) {
        logger.error(`Failed to fetch profile: ${error.message}`);
        res.status(500).json({ error: 'Failed to fetch profile.' });
    }
});

router.get('/api/me/scripts', requireAuth, async (req, res) => {
    try {
        const limit = Number.parseInt(req.query.limit, 10);
        const offset = Number.parseInt(req.query.offset, 10);
        const scripts = await db.getUserScripts(req.user.id, { limit, offset });
        res.json({
            data: scripts.items, pagination: {
                total: scripts.total,
                limit: scripts.limit,
                offset: scripts.offset,
                hasMore: scripts.hasMore
            }
        });
    } catch (error) {
        logger.error(`Failed to fetch user scripts: ${error.message}`);
        res.status(500).json({ error: 'Failed to fetch scripts.' });
    }
});

router.get('/api/me/scripts/:id', requireAuth, async (req, res) => {
    try {
        const script = await db.getUserScriptById(req.user.id, req.params.id);
        res.json({ data: script });
    } catch (error) {
        logger.error(`Failed to fetch script ${req.params.id}: ${error.message}`);
        res.status(404).json({ error: 'Script not found.' });
    }
});

router.put('/api/me/profile', requireAuth, async (req, res) => {
    try {
        const fullName = (req.body.full_name || '').trim();
        const { first_name, last_name } = splitFullName(fullName);
        const profile = await db.upsertProfile(req.user.id, {
            first_name,
            last_name,
            email: req.user.email,
            avatar_url: req.body.avatar_url || undefined
        });

        res.json({
            data: {
                ...profile,
                full_name: [profile.first_name, profile.last_name].filter(Boolean).join(' ').trim()
            }
        });
    } catch (error) {
        logger.error(`Failed to update profile: ${error.message}`);
        res.status(500).json({ error: 'Failed to update profile.' });
    }
});

router.post('/api/me/avatar', requireAuth, async (req, res) => {
    try {
        const { avatar_base64 } = req.body || {};
        if (!avatar_base64) {
            return res.status(400).json({ error: 'avatar_base64 is required.' });
        }

        const image = parseBase64Image(avatar_base64);
        const avatarUrl = await db.uploadAvatar(req.user.id, image.buffer, image.contentType);
        const profile = await db.upsertProfile(req.user.id, {
            email: req.user.email,
            avatar_url: avatarUrl
        });

        res.json({
            data: {
                avatar_url: avatarUrl,
                profile
            }
        });
    } catch (error) {
        logger.error(`Failed to upload avatar: ${error.message}`);
        res.status(500).json({ error: 'Failed to upload avatar.' });
    }
});

module.exports = router;
