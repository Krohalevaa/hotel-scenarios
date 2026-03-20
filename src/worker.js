const scraper = require('./scraper');
const geo = require('./geo');
const ai = require('./ai');
const db = require('./db');
const email = require('./email');
const logger = require('./logger');
const { consumeFromQueue } = require('./rabbitmq');

/**
 * Main hotel processing worker logic.
 */
async function processHotelData(hotelData) {
    const hotelLogName = hotelData.hotel_name || hotelData.hotel_website_url;
    logger.info(`=== Starting processing for hotel: "${hotelLogName}" ===`);

    try {
        // Step 1: Geocoding & Name Normalization
        logger.info('Step 1: Starting Geocoding & Name Normalization...');
        
        // Task 14: Consolidate AI calls. predictOsmHotelData handles name extraction.
        const osmPrediction = await ai.predictOsmHotelData(
            hotelData.hotel_name, 
            hotelData.city || 'Unknown', 
            hotelData.hotel_website_url
        );
        
        const canonicalName = osmPrediction.osm_target_name || hotelData.hotel_name || 'Hotel';
        logger.info(`Canonical Hotel Name set: "${hotelLogName}" -> "${canonicalName}"`);
        
        // Update hotelData with normalized info
        hotelData.hotel_name = canonicalName;
        
        // Task 4: geo.getGeoCoordinates already handles city fallback internally.
        const geoResult = await geo.getGeoCoordinates(
            hotelData.hotel_name, 
            hotelData.city, 
            hotelData.hotel_website_url, 
            osmPrediction
        );

        hotelData.geo_lat = geoResult.geo_lat;
        hotelData.geo_lon = geoResult.geo_lon;
        hotelData.address = geoResult.address;
        hotelData._geo_debug = geoResult._geo_debug_name;
        
        logger.info(`Geocoding finished. Result: ${hotelData._geo_debug} [${hotelData.geo_lat}, ${hotelData.geo_lon}]`);

        // Step 2: Nearby Attractions
        if (hotelData.geo_lat && hotelData.geo_lon) {
            logger.info('Step 2: Searching for nearby attractions...');
            // Task 2: Give Overpass a breath
            await new Promise(resolve => setTimeout(resolve, 3000));
            const attractions = await geo.searchAttractions(hotelData.geo_lat, hotelData.geo_lon);
            logger.info(`Found ${attractions.length} attractions.`);

            // Save POIs to ClickHouse
            if (attractions.length > 0) {
                logger.info('Saving categorized POIs to database (hotel_poi)...');
                await db.saveCategorizedPois(hotelData.hotel_name, attractions);
            }
        }

        // Step 3: SQL Schema Generation
        logger.info('Step 3: Generating SQL via AI...');
        const sqlQuery = await ai.generateSchemaSQL(hotelData);
        if (sqlQuery) {
            logger.info('Executing SQL query in ClickHouse...');
            await db.executeClickHouseQuery(sqlQuery);
            logger.info('SQL execution successful.');
        }

        // Step 4: Video Script & Email
        logger.info('Step 4: Generating video script via AI...');
        
        // Task 5: Fallback for empty location/description
        hotelData.location = hotelData.location || hotelData.address || hotelData.city || 'Unknown';
        hotelData.description = hotelData.description || `A beautiful hotel in ${hotelData.location}`;
        
        const scriptContent = await ai.generateScript(hotelData);
        if (scriptContent) {
            logger.info('Script generated successfully.');
            
            // Task 1: Improved email error handling
            try {
                const targetEmail = hotelData.contact_email || 'akrohaleva67@gmail.com';
                logger.info(`Sending email to ${targetEmail}...`);
                await email.sendEmail(targetEmail, `Video Script: ${hotelData.hotel_name}`, scriptContent);
                logger.info('Email sent successfully.');
            } catch (emailErr) {
                logger.error(`Email Step Failed: ${emailErr.message}`);
            }
        }

        logger.info(`=== Successfully finished processing hotel: "${hotelData.hotel_name}" ===`);

    } catch (err) {
        logger.error(`Critical error processing hotel "${hotelLogName}": ${err.message}`);
        logger.error(err.stack);
    }
}

function startWorker() {
    logger.info('Initializing Worker...');
    consumeFromQueue(processHotelData);
    logger.info('Worker started and listening for RabbitMQ messages.');
}

module.exports = { startWorker };
