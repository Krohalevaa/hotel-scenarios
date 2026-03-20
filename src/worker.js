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

    let scriptRecord = null;

    try {
        scriptRecord = await db.saveScript({
            user_id: hotelData.user_id,
            contact_email: hotelData.contact_email,
            hotel_website_url: hotelData.hotel_website_url,
            business_goal: hotelData.business_goal,
            city: hotelData.city,
            language: hotelData.language || 'Russian',
            status: 'processing',
            hotel_name: hotelData.hotel_name || null
        });

        const scriptId = scriptRecord.id;

        logger.info('Step 1: Starting Geocoding & Name Normalization...');

        const osmPrediction = await ai.predictOsmHotelData(
            hotelData.hotel_name,
            hotelData.city || 'Unknown',
            hotelData.hotel_website_url
        );

        const canonicalName = osmPrediction.osm_target_name || hotelData.hotel_name || 'Hotel';
        logger.info(`Canonical Hotel Name set: "${hotelLogName}" -> "${canonicalName}"`);

        hotelData.hotel_name = canonicalName;

        await db.saveScript({
            id: scriptId,
            user_id: hotelData.user_id,
            contact_email: hotelData.contact_email,
            hotel_website_url: hotelData.hotel_website_url,
            business_goal: hotelData.business_goal,
            city: hotelData.city,
            language: hotelData.language || 'Russian',
            status: 'processing',
            hotel_name: canonicalName
        });

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

        if (hotelData.geo_lat && hotelData.geo_lon) {
            logger.info('Step 2: Searching for nearby attractions...');
            await new Promise((resolve) => setTimeout(resolve, 3000));
            const attractions = await geo.searchAttractions(hotelData.geo_lat, hotelData.geo_lon);
            logger.info(`Found ${attractions.length} attractions.`);

            hotelData.nearby_attractions = attractions.map((item) => item.name || item.attraction_name).filter(Boolean);

            if (attractions.length > 0) {
                logger.info('Saving attractions to Supabase...');
                await db.saveAttractions(scriptId, attractions);
            }
        }

        logger.info('Step 3: Generating video script via AI...');

        hotelData.location = hotelData.location || hotelData.address || hotelData.city || 'Unknown';
        hotelData.description = hotelData.description || `A beautiful hotel in ${hotelData.location}`;

        let scriptContent;
        try {
            scriptContent = await ai.generateScript(hotelData);
            logger.debug(`AI script result received for script ${scriptId}: hasContent=${Boolean(scriptContent)} length=${scriptContent?.length || 0}`);
        } catch (error) {
            logger.warn(`AI script generation failed for script ${scriptId}, using fallback script: ${error.message}`);
            scriptContent = ai.buildFallbackScript(hotelData);
            logger.debug(`Fallback script created from catch block for script ${scriptId}: length=${scriptContent?.length || 0}`);
        }

        if (!scriptContent) {
            logger.warn(`AI returned empty script for ${scriptId}, using fallback script.`);
            scriptContent = ai.buildFallbackScript(hotelData);
            logger.debug(`Fallback script created after empty AI response for script ${scriptId}: length=${scriptContent?.length || 0}`);
        }

        logger.info(`Persisting completed script ${scriptId}: finalLength=${scriptContent?.length || 0}, emailTarget=${hotelData.contact_email || 'akrohaleva67@gmail.com'}`);
        await db.updateScriptStatus(scriptId, 'completed', scriptContent);
        logger.info('Script generated successfully.');

        try {
            const targetEmail = hotelData.contact_email || 'akrohaleva67@gmail.com';
            logger.info(`Sending email to ${targetEmail}...`);
            await email.sendEmail(targetEmail, `Video Script: ${hotelData.hotel_name}`, scriptContent);
            logger.info('Email sent successfully.');
        } catch (emailErr) {
            logger.error(`Email Step Failed: ${emailErr.message}`);
        }

        logger.info(`=== Successfully finished processing hotel: "${hotelData.hotel_name}" ===`);
    } catch (err) {
        if (scriptRecord?.id) {
            try {
                await db.updateScriptStatus(scriptRecord.id, 'failed');
            } catch (statusErr) {
                logger.error(`Failed to update script status: ${statusErr.message}`);
            }
        }

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
