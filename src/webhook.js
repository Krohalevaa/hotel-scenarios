const express = require('express');
const { scrapeHotelWebsite, extractHotelInfo } = require('./scraper');
const { publishToQueue } = require('./rabbitmq');
const logger = require('./logger');

const router = express.Router();

/**
 * Helper to process a single hotel (Scrape -> Extract -> Queue)
 */
async function processSingleHotel(hotelRequest) {
    const context = {
        request_id: Date.now().toString() + Math.random().toString(16).slice(2),
        created_at: new Date().toISOString(),
        hotel_website_url: hotelRequest.hotel_website_url,
        business_goal: hotelRequest.business_goal,
        contact_email: hotelRequest.contact_email,
        city: hotelRequest.city,
        hotel_context: "",
        status: "new",
        language: hotelRequest.language || "English"
    };

    let hotelData;
    try {
        logger.info(`Processing entry: ${context.hotel_website_url}`);
        const rawData = await scrapeHotelWebsite(context.hotel_website_url);
        hotelData = extractHotelInfo(rawData, context);
    } catch (e) {
        logger.error(`Scraping failed for ${context.hotel_website_url}, using fallback: ${e.message}`);
        // Fallback: Create minimal data so processing can continue
        const domain = new URL(context.hotel_website_url).hostname.replace('www.', '');
        hotelData = {
            hotel_name: domain, // AI will try to clean this later in worker.js
            description: "Website could not be scraped. Processing with minimal info.",
            city: context.city,
            hotel_website_url: context.hotel_website_url,
            contact_email: context.contact_email,
            business_goal: context.business_goal,
            language: context.language,
            amenities: [],
            special_offers: []
        };
    }

    try {
        await publishToQueue(hotelData);
    } catch (e) {
        logger.error(`Error publishing to queue for ${context.hotel_website_url}: ${e.message}`);
    }
}

router.post('/generate-script', async (req, res) => {
    res.json({
        status: "success",
        message: "Request received. Please check your email shortly."
    });

    // Background process for single hotel
    processSingleHotel(req.body);
});

// Task 11: Parallel bulk processing (Batch size 3)
router.post('/api/bulk-generate-script', async (req, res) => {
    // Support both: a raw array  [ {...}, {...} ]
    // and an object with key:  { hotels: [ {...}, {...} ] }
    const hotels = Array.isArray(req.body) ? req.body : req.body?.hotels;
    if (!hotels || !Array.isArray(hotels)) {
        return res.status(400).json({ error: 'Expected an array of hotels.' });
    }

    res.json({ message: `Started processing ${hotels.length} hotels in batches. Check logs for progress.` });

    // Background processing
    const BATCH_SIZE = 3;
    (async () => {
        for (let i = 0; i < hotels.length; i += BATCH_SIZE) {
            const batch = hotels.slice(i, i + BATCH_SIZE);
            logger.info(`Processing Batch ${Math.floor(i / BATCH_SIZE) + 1} (${batch.length} hotels)...`);
            
            await Promise.allSettled(batch.map(async (hotel) => {
                try {
                    await processSingleHotel(hotel);
                } catch (err) {
                    logger.error(`Batch item failed: ${err.message}`);
                }
            }));
            
            // Short pause between batches to avoid overwhelming APIs
            if (i + BATCH_SIZE < hotels.length) {
                await new Promise(r => setTimeout(r, 5000));
            }
        }
    })();
});

module.exports = router;
