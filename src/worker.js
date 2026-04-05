const scraper = require('./scraper');
const geo = require('./geo');
const ai = require('./ai');
const db = require('./db');
const email = require('./email');
const logger = require('./logger');
const config = require('./config');
const { consumeFromQueue } = require('./rabbitmq');
const { DEFAULT_RADIUS_METERS, parseGuestPreference } = require('./placePreferences');

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
    logger.info(`New request: ${hotelLogName}`);

    let scriptRecord = null;

    try {
        logger.info('Step 1/6: creating scenario');
        scriptRecord = await db.saveScript({
            user_id: hotelData.user_id,
            contact_email: hotelData.contact_email,
            hotel_url: hotelData.hotel_website_url,
            business_goal: hotelData.business_goal,
            guest_preference: hotelData.guest_preference || null,
            city: hotelData.city,
            country: hotelData.country || null,
            language: hotelData.language || 'English',
            status: 'processing',
            hotel_name: hotelData.hotel_name || null,
            selected_place_categories: []
        });

        const scenarioId = scriptRecord.id;
        logger.info(`Scenario created: ${scenarioId}`);
        logger.info('Step 2/6: finding hotel coordinates');

        const osmPrediction = await ai.predictOsmHotelData(
            hotelData.hotel_name,
            hotelData.city || 'Unknown',
            hotelData.hotel_website_url
        );

        const canonicalName = osmPrediction.osm_target_name || hotelData.hotel_name || 'Hotel';
        logger.info(`Confirmed hotel name: ${canonicalName}`);

        hotelData.hotel_name = canonicalName;

        await db.saveScript({
            id: scenarioId,
            user_id: hotelData.user_id,
            contact_email: hotelData.contact_email,
            hotel_url: hotelData.hotel_website_url,
            business_goal: hotelData.business_goal,
            guest_preference: hotelData.guest_preference || null,
            city: hotelData.city,
            country: hotelData.country || null,
            language: hotelData.language || 'English',
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
        hotelData.country = hotelData.country || null;
        hotelData._geo_debug = geoResult._geo_debug_name;

        logger.info(`Coordinates found: [${hotelData.geo_lat}, ${hotelData.geo_lon}]`);

        let allNearbyPlaces = [];
        let recommendedPlaces = [];
        let selectedCategories = parseGuestPreference(hotelData.guest_preference);

        if (hotelData.geo_lat && hotelData.geo_lon) {
            logger.info('Step 3/6: searching nearby attractions');
            await new Promise((resolve) => setTimeout(resolve, 3000));
            allNearbyPlaces = await geo.searchPublicPlaces(hotelData.geo_lat, hotelData.geo_lon, {
                radius: DEFAULT_RADIUS_METERS
            });
            logger.info(`Nearby places found: ${allNearbyPlaces.length}`);
            logger.info('Saving discovered places');
            const initialDiscoveredAttractionsRecord = await db.saveDiscoveredAttractions(
                scenarioId,
                hotelData.hotel_name,
                hotelData.city,
                hotelData.country || null,
                allNearbyPlaces
            );

            hotelData.discovered_attractions = initialDiscoveredAttractionsRecord ? [initialDiscoveredAttractionsRecord] : [];

            logger.info('Step 4/6: selecting relevant places');
            const placeSelection = await ai.selectRelevantPlaces(hotelData);
            selectedCategories = placeSelection.selectedCategories?.length
                ? placeSelection.selectedCategories
                : selectedCategories;
            recommendedPlaces = placeSelection.recommendedPlaces || [];

            const discoveredAttractionsRecord = await db.saveDiscoveredAttractions(
                scenarioId,
                hotelData.hotel_name,
                hotelData.city,
                hotelData.country || null,
                allNearbyPlaces,
                recommendedPlaces
            );

            hotelData.discovered_attractions = discoveredAttractionsRecord ? [discoveredAttractionsRecord] : [];

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
                country: hotelData.country || null,
                language: hotelData.language || 'English',
                status: 'processing',
                hotel_name: canonicalName,
                selected_place_categories: selectedCategories
            });

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

        logger.info('Step 5/6: building final script');

        hotelData.location = hotelData.location || hotelData.address || hotelData.city || 'Unknown';
        hotelData.description = hotelData.description || `A beautiful hotel in ${hotelData.location}`;

        let scriptContent;
        try {
            scriptContent = await ai.generateScript(hotelData);
            logger.debug(`AI script result received for scenario ${scenarioId}: hasContent=${Boolean(scriptContent)} length=${scriptContent?.length || 0}`);
        } catch (error) {
            logger.warn(`Failed to build script with AI, using fallback instead: ${error.message}`);
            scriptContent = ai.buildFallbackScript(hotelData);
            logger.debug(`Fallback script created from catch block for scenario ${scenarioId}: length=${scriptContent?.length || 0}`);
        }

        if (!scriptContent) {
            logger.warn('AI returned an empty script, using fallback instead');
            scriptContent = ai.buildFallbackScript(hotelData);
            logger.debug(`Fallback script created after empty AI response for scenario ${scenarioId}: length=${scriptContent?.length || 0}`);
        }

        logger.info('Step 6/6: saving result and sending email');
        await db.updateScriptStatus(scenarioId, 'completed', scriptContent);
        logger.info(`Scenario ready: ${scenarioId}`);

        try {
            const targetEmail = hotelData.contact_email || config.GUEST_USER_EMAIL || 'akrohaleva67@gmail.com';
            logger.info(`Sending script to ${targetEmail}`);
            await email.sendEmail(targetEmail, `Video Script: ${hotelData.hotel_name}`, scriptContent);
            logger.info('Email sent');
        } catch (emailErr) {
            logger.error(`Email Step Failed: ${emailErr.message}`);
        }

        logger.info(`Done: ${hotelData.hotel_name}`);
    } catch (err) {
        logger.error(`Processing error for ${hotelLogName}: ${err.message}`);
        if (scriptRecord?.id) {
            try {
                await db.updateScriptStatus(scriptRecord.id, 'failed');
            } catch (statusErr) {
                logger.error(`Failed to update scenario status: ${statusErr.message}`);
            }
        }

        logger.error(`Critical error: ${err.message}`);
    }
}

function startWorker() {
    logger.info('Worker started');
    consumeFromQueue(processHotelData);
    logger.info('Waiting for new requests');
}

module.exports = { startWorker };
