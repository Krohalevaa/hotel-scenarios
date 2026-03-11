const { consumeFromQueue } = require('./rabbitmq');
const { getGeoCoordinates, searchAttractions } = require('./geo');
const { saveAttractions, executeClickHouseQuery } = require('./db');
const { generateSchemaSQL, generateScript, extractCleanHotelName } = require('./ai');
const { sendEmail } = require('./email');
const logger = require('./logger');

async function processHotelData(hotelData) {
    logger.info(`=== Starting processing for hotel: "${hotelData.hotel_name}" ===`);

    try {
        // 1. Geocoding
        logger.info('Step 1: Starting Geocoding process...');
        const cleanName = await extractCleanHotelName(hotelData.hotel_name) || hotelData.hotel_name;
        logger.info(`AI Cleaned Name: "${hotelData.hotel_name}" -> "${cleanName}"`);

        const geoData = await getGeoCoordinates(cleanName, hotelData.city);
        hotelData.geo_lat = geoData.geo_lat;
        hotelData.geo_lon = geoData.geo_lon;
        hotelData._geo_debug_name = geoData._geo_debug_name;
        logger.info(`Geocoding finished. Result: ${geoData._geo_debug_name} [${geoData.geo_lat}, ${geoData.geo_lon}]`);

        // 2. Attractions
        if (hotelData.geo_lat && hotelData.geo_lon) {
            logger.info('Step 2: Searching for nearby attractions...');
            const attractions = await searchAttractions(hotelData.geo_lat, hotelData.geo_lon);
            hotelData.nearby_attractions = attractions;
            logger.info(`Found ${attractions.length} attractions.`);

            if (attractions.length > 0) {
                logger.info('Saving attractions to database...');
                await saveAttractions(hotelData.hotel_name, attractions);
            }
        } else {
            logger.warn('Skipping attractions search because coordinates are missing.');
        }

        // 3. Generate Schema SQL
        logger.info('Step 3: Generating SQL via AI...');
        const sql = await generateSchemaSQL(hotelData);
        if (sql) {
            logger.info('Executing SQL query in ClickHouse...');
            await executeClickHouseQuery(sql);
            logger.info('SQL execution successful.');
        } else {
            logger.error('Failed to generate SQL.');
        }

        // 4. Generate Script and Email
        logger.info('Step 4: Generating video script via AI...');
        const scriptContent = await generateScript(hotelData);
        if (scriptContent) {
            logger.info('Script generated successfully.');
            if (hotelData.contact_email) {
                logger.info(`Sending email to ${hotelData.contact_email}...`);
                await sendEmail(hotelData.contact_email, "Scenario", scriptContent);
                logger.info('Email sent.');
            } else {
                logger.warn('No contact email provided, skipping email sending.');
            }
        } else {
            logger.error('Failed to generate script.');
        }

        logger.info(`=== Successfully finished processing hotel: "${hotelData.hotel_name}" ===`);
    } catch (err) {
        logger.error(`Critical error processing hotel "${hotelData.hotel_name}": ${err.message}`);
    }
}

function startWorker() {
    logger.info('Initializing Worker...');
    consumeFromQueue(processHotelData);
    logger.info('Worker started and listening for RabbitMQ messages.');
}

module.exports = { startWorker };
