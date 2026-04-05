const express = require('express');
const { scrapeHotelWebsite, extractHotelInfo } = require('./scraper');
const { publishToQueue } = require('./rabbitmq');
const { requireAuth } = require('./auth');
const db = require('./db');
const logger = require('./logger');
const config = require('./config');

const router = express.Router();

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
        logger.info(`Получен сайт отеля: ${context.hotel_website_url}`);
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
        logger.warn(`Не удалось прочитать сайт, продолжаем с минимальными данными: ${e.message}`);
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
    logger.info(`Запрос поставлен в обработку: ${context.hotel_website_url}`);
}

router.post('/generate-script', requireAuth, async (req, res) => {
    const payload = {
        ...req.body,
        user_id: req.user.id,
        contact_email: req.body.contact_email || req.user.email
    };

    logger.info(`Новый запрос пользователя: ${payload.hotel_website_url}`);

    res.json({
        status: 'success',
        message: 'Request received. Please check your email shortly.'
    });

    processSingleHotel(payload).catch((error) => {
        logger.error(`Ошибка фоновой обработки: ${error.message}`);
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
        logger.warn(`Гостевой профиль создан автоматически: ${guestEmail}`);
    }

    payload.user_id = guestUserId;

    logger.info(`Новый гостевой запрос: ${payload.hotel_website_url}`);

    res.json({
        status: 'success',
        message: 'Request received. We will send the script to your email.'
    });

    processSingleHotel(payload).catch((error) => {
        logger.error(`Ошибка фоновой обработки гостевого запроса: ${error.message}`);
    });
});

router.post('/api/bulk-generate-script', requireAuth, async (req, res) => {
    const hotels = Array.isArray(req.body) ? req.body : req.body?.hotels;
    if (!hotels || !Array.isArray(hotels)) {
        return res.status(400).json({ error: 'Expected an array of hotels.' });
    }

    logger.info(`Получен пакет запросов: ${hotels.length}`);

    res.json({ message: `Started processing ${hotels.length} hotels in batches. Check logs for progress.` });

    const BATCH_SIZE = 3;
    (async () => {
        for (let i = 0; i < hotels.length; i += BATCH_SIZE) {
            const batch = hotels.slice(i, i + BATCH_SIZE);
            logger.info(`Обрабатываем пакет ${Math.floor(i / BATCH_SIZE) + 1}: ${batch.length} отелей`);

            await Promise.allSettled(
                batch.map(async (hotel) => {
                    try {
                        await processSingleHotel({
                            ...hotel,
                            user_id: req.user.id,
                            contact_email: hotel.contact_email || req.user.email
                        });
                    } catch (err) {
                        logger.error(`Ошибка в одном из отелей пакета: ${err.message}`);
                    }
                })
            );

            if (i + BATCH_SIZE < hotels.length) {
                await new Promise((resolve) => setTimeout(resolve, 5000));
            }
        }
    })();
});

router.get('/api/me/scripts', requireAuth, async (req, res) => {
    try {
        const scripts = await db.getUserScripts(req.user.id);
        res.json({ data: scripts });
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
        const { avatar } = req.body;
        if (!avatar) {
            return res.status(400).json({ error: 'Avatar is required.' });
        }

        const { buffer, contentType } = parseBase64Image(avatar);
        const upload = await db.uploadAvatar(req.user.id, buffer, contentType);
        const existingProfile = await db.getProfile(req.user.id);
        const profile = await db.upsertProfile(req.user.id, {
            first_name: existingProfile?.first_name || req.user.user_metadata?.first_name || null,
            last_name: existingProfile?.last_name || req.user.user_metadata?.last_name || null,
            email: existingProfile?.email || req.user.email,
            avatar_url: upload.publicUrl
        });

        res.json({
            data: {
                ...upload,
                avatar_url: profile?.avatar_url || upload.publicUrl,
                full_name: [profile?.first_name, profile?.last_name].filter(Boolean).join(' ').trim()
            }
        });
    } catch (error) {
        logger.error(`Failed to upload avatar: ${error.message}`);
        res.status(500).json({ error: 'Failed to upload avatar.' });
    }
});

router.get('/api/me/profile', requireAuth, async (req, res) => {
    try {
        const profile = await db.getProfile(req.user.id);
        const firstName = profile?.first_name || req.user.user_metadata?.first_name || null;
        const lastName = profile?.last_name || req.user.user_metadata?.last_name || null;

        res.json({
            data: {
                user_id: req.user.id,
                email: profile?.email || req.user.email,
                first_name: firstName,
                last_name: lastName,
                full_name: [firstName, lastName].filter(Boolean).join(' ').trim(),
                avatar_url: profile?.avatar_url || null,
                created_at: profile?.created_at || null,
                updated_at: profile?.updated_at || null
            }
        });
    } catch (error) {
        logger.error(`Failed to fetch profile: ${error.message}`);
        res.status(500).json({ error: 'Failed to fetch profile.' });
    }
});

module.exports = router;
