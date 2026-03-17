const express = require('express');
const { scrapeHotelWebsite, extractHotelInfo } = require('./scraper');
const { publishToQueue } = require('./rabbitmq');

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
        console.log(`Processing entry: ${context.hotel_website_url}`);
        const rawData = await scrapeHotelWebsite(context.hotel_website_url);
        hotelData = extractHotelInfo(rawData, context);
    } catch (e) {
        console.error(`Scraping failed for ${context.hotel_website_url}, using fallback:`, e.message);
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
        console.error(`Error publishing to queue for ${context.hotel_website_url}:`, e.message);
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

router.post('/api/bulk-generate-script', async (req, res) => {
    const hotels = req.body;
    if (!Array.isArray(hotels)) {
        return res.status(400).json({ status: "error", message: "Expected an array of hotels." });
    }

    res.json({
        status: "success",
        message: `Bulk processing started for ${hotels.length} hotels. Please check your email.`
    });

    // Background process for multiple hotels
    for (const hotel of hotels) {
        await processSingleHotel(hotel);
    }
});

module.exports = router;
