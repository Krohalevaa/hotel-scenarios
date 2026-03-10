const express = require('express');
const { scrapeHotelWebsite, extractHotelInfo } = require('./scraper');
const { publishToQueue } = require('./rabbitmq');

const router = express.Router();

router.post('/generate-script', async (req, res) => {
    // 1. Quick Status Response (n8n Webhook Node + Respond to Webhook Node)
    res.json({
        status: "success",
        message: "Dear user, please check your email."
    });

    // 2. Initialize Parameters
    const context = {
        request_id: Date.now().toString(),
        created_at: new Date().toISOString(),
        hotel_website_url: req.body.hotel_website_url,
        business_goal: req.body.business_goal,
        contact_email: req.body.contact_email,
        city: req.body.city,
        hotel_context: "",
        status: "new",
        language: req.body.language || "English"
    };

    try {
        // 3. Scrape Hotel Website
        const rawData = await scrapeHotelWebsite(context.hotel_website_url);

        // 4. Extract Hotel Info
        const hotelData = extractHotelInfo(rawData, context);

        // 5. RabbitMQ: Publish
        await publishToQueue(hotelData);
    } catch (e) {
        console.error("Error in webhook background process:", e.message);
    }
});

module.exports = router;
