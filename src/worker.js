const scraper = require('./scraper');
const geo = require('./geo');
const ai = require('./ai');
const db = require('./db');
const email = require('./email');
const logger = require('./logger');
const config = require('./config');
const { consumeFromQueue } = require('./rabbitmq');
const { DEFAULT_RADIUS_METERS } = require('./placePreferences');

function collectKeyFeatures(hotelData) {
    const candidates = [
        ...(Array.isArray(hotelData.amenities) ? hotelData.amenities : []),
        ...(Array.isArray(hotelData.special_offers) ? hotelData.special_offers : [])
    ];

    return [...new Set(
        candidates
            .map((item) => String(item || '').trim())
            .filter(Boolean)
    )].slice(0, 5);
}

async function processHotelData(hotelData) {
    const hotelLogName = hotelData.hotel_name || hotelData.hotel_website_url;
    logger.info(`=== Starting processing for hotel: "${hotelLogName}" ===`);
    logger.info(`[worker] Incoming job payload: user=${hotelData?.user_id || 'n/a'}, hotelUrl=${hotelData?.hotel_website_url || 'n/a'}, city=${hotelData?.city || 'n/a'}, email=${hotelData?.contact_email || 'n/a'}, hasName=${Boolean(hotelData?.hotel_name)}`);

    let scriptRecord = null;

    try {
        logger.info(`[worker] About to create initial DB record for hotel="${hotelLogName}"`);
        scriptRecord = await db.saveScript({
            user_id: hotelData.user_id,
            contact_email: hotelData.contact_email,
            hotel_url: hotelData.hotel_website_url,
            business_goal: hotelData.business_goal,
            guest_preference: hotelData.guest_preference || null,
            city: hotelData.city,
            language: hotelData.language || 'Russian',
            status: 'processing',
            hotel_name: hotelData.hotel_name || null,
            selected_place_categories: []
        });

        const scenarioId = scriptRecord.id;
        logger.info(`[worker] Initial DB record created: scenarioId=${scenarioId}, status=${scriptRecord.status}`);

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
            id: scenarioId,
            user_id: hotelData.user_id,
            contact_email: hotelData.contact_email,
            hotel_url: hotelData.hotel_website_url,
            business_goal: hotelData.business_goal,
            guest_preference: hotelData.guest_preference || null,
            city: hotelData.city,
            language: hotelData.language || 'Russian',
            status: 'processing',
            hotel_name: canonicalName,
            selected_place_categories: []
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

        let allNearbyPlaces = [];
        let recommendedPlaces = [];
        let selectedCategories = [];

        if (hotelData.geo_lat && hotelData.geo_lon) {
            logger.info(`Step 2: Searching for nearby public places within ${DEFAULT_RADIUS_METERS} meters...`);
            await new Promise((resolve) => setTimeout(resolve, 3000));
            allNearbyPlaces = await geo.searchPublicPlaces(hotelData.geo_lat, hotelData.geo_lon, {
                radius: DEFAULT_RADIUS_METERS
            });
            logger.info(`Found ${allNearbyPlaces.length} public places.`);

            hotelData.all_nearby_places = allNearbyPlaces;

            logger.info('Step 3: AI agent is selecting preference-matching places...');
            const placeSelection = await ai.selectRelevantPlaces(hotelData);
            selectedCategories = placeSelection.selectedCategories || [];
            recommendedPlaces = placeSelection.recommendedPlaces || [];

            hotelData.selected_place_categories = selectedCategories;
            hotelData.recommended_places = recommendedPlaces;
            hotelData.nearby_attractions = recommendedPlaces.map((item) => item.name || item.attraction_name).filter(Boolean);

            await db.saveScript({
                id: scenarioId,
                user_id: hotelData.user_id,
                contact_email: hotelData.contact_email,
                hotel_url: hotelData.hotel_website_url,
                business_goal: hotelData.business_goal,
                guest_preference: hotelData.guest_preference || null,
                city: hotelData.city,
                language: hotelData.language || 'Russian',
                status: 'processing',
                hotel_name: canonicalName,
                selected_place_categories: selectedCategories
            });

            if (allNearbyPlaces.length > 0) {
                logger.info('Saving public places to Supabase...');
                await db.saveAttractions(scenarioId, hotelData.hotel_name, allNearbyPlaces);
            }
        }

        await db.saveHotelSourceData({
            scenario_id: scenarioId,
            hotel_url: hotelData.hotel_website_url,
            hotel_name: hotelData.hotel_name,
            city: hotelData.city,
            country: hotelData.country || null,
            address: hotelData.address || null,
            latitude: hotelData.geo_lat,
            longitude: hotelData.geo_lon,
            attractions_found: allNearbyPlaces.length > 0,
            key_features: collectKeyFeatures(hotelData),
            attraction_count: allNearbyPlaces.length,
            selected_attraction_count: recommendedPlaces.length,
            search_radius_meters: DEFAULT_RADIUS_METERS,
            selected_place_categories: selectedCategories
        });

        logger.info('Step 4: Generating video script via AI...');

        hotelData.location = hotelData.location || hotelData.address || hotelData.city || 'Unknown';
        hotelData.description = hotelData.description || `A beautiful hotel in ${hotelData.location}`;

        let scriptContent;
        try {
            scriptContent = await ai.generateScript(hotelData);
            logger.debug(`AI script result received for scenario ${scenarioId}: hasContent=${Boolean(scriptContent)} length=${scriptContent?.length || 0}`);
        } catch (error) {
            logger.warn(`AI script generation failed for scenario ${scenarioId}, using fallback script: ${error.message}`);
            scriptContent = ai.buildFallbackScript(hotelData);
            logger.debug(`Fallback script created from catch block for scenario ${scenarioId}: length=${scriptContent?.length || 0}`);
        }

        if (!scriptContent) {
            logger.warn(`AI returned empty script for ${scenarioId}, using fallback script.`);
            scriptContent = ai.buildFallbackScript(hotelData);
            logger.debug(`Fallback script created after empty AI response for scenario ${scenarioId}: length=${scriptContent?.length || 0}`);
        }

        logger.info(`Persisting completed scenario ${scenarioId}: finalLength=${scriptContent?.length || 0}, emailTarget=${hotelData.contact_email || config.GUEST_USER_EMAIL || 'akrohaleva67@gmail.com'}`);
        await db.updateScriptStatus(scenarioId, 'completed', scriptContent);
        logger.info(`[worker] Final DB update completed: scenarioId=${scenarioId}, finalScriptLength=${scriptContent?.length || 0}`);
        logger.info('Script generated successfully.');

        try {
            const targetEmail = hotelData.contact_email || config.GUEST_USER_EMAIL || 'akrohaleva67@gmail.com';
            logger.info(`Sending email to ${targetEmail}...`);
            await email.sendEmail(targetEmail, `Video Script: ${hotelData.hotel_name}`, scriptContent);
            logger.info('Email sent successfully.');
        } catch (emailErr) {
            logger.error(`Email Step Failed: ${emailErr.message}`);
        }

        logger.info(`=== Successfully finished processing hotel: "${hotelData.hotel_name}" ===`);
    } catch (err) {
        logger.error(`[worker] Processing failed before completion for hotel="${hotelLogName}", scenarioId=${scriptRecord?.id || 'not-created'}: ${err.message}`);
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
