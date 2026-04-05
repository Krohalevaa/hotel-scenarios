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
    logger.info(`Новый запрос: ${hotelLogName}`);

    let scriptRecord = null;

    try {
        logger.info('Шаг 1/6: создаём сценарий');
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
        logger.info(`Сценарий создан: ${scenarioId}`);
        logger.info('Шаг 2/6: ищем координаты отеля');

        const osmPrediction = await ai.predictOsmHotelData(
            hotelData.hotel_name,
            hotelData.city || 'Unknown',
            hotelData.hotel_website_url
        );

        const canonicalName = osmPrediction.osm_target_name || hotelData.hotel_name || 'Hotel';
        logger.info(`Подтвердили название: ${canonicalName}`);

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

        logger.info(`Координаты найдены: [${hotelData.geo_lat}, ${hotelData.geo_lon}]`);

        let allNearbyPlaces = [];
        let recommendedPlaces = [];
        let selectedCategories = [];

        if (hotelData.geo_lat && hotelData.geo_lon) {
            logger.info('Шаг 3/6: ищем достопримечательности рядом');
            await new Promise((resolve) => setTimeout(resolve, 3000));
            allNearbyPlaces = await geo.searchPublicPlaces(hotelData.geo_lat, hotelData.geo_lon, {
                radius: DEFAULT_RADIUS_METERS
            });
            logger.info(`Найдено мест рядом: ${allNearbyPlaces.length}`);
            logger.info('Сохраняем найденные места');
            const initialDiscoveredAttractionsRecord = await db.saveDiscoveredAttractions(
                scenarioId,
                hotelData.hotel_name,
                hotelData.city,
                hotelData.country || null,
                allNearbyPlaces
            );

            hotelData.discovered_attractions = initialDiscoveredAttractionsRecord ? [initialDiscoveredAttractionsRecord] : [];

            logger.info('Шаг 4/6: отбираем подходящие места');
            const placeSelection = await ai.selectRelevantPlaces(hotelData);
            selectedCategories = placeSelection.selectedCategories || [];
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

        logger.info('Шаг 5/6: собираем финальный сценарий');

        hotelData.location = hotelData.location || hotelData.address || hotelData.city || 'Unknown';
        hotelData.description = hotelData.description || `A beautiful hotel in ${hotelData.location}`;

        let scriptContent;
        try {
            scriptContent = await ai.generateScript(hotelData);
            logger.debug(`AI script result received for scenario ${scenarioId}: hasContent=${Boolean(scriptContent)} length=${scriptContent?.length || 0}`);
        } catch (error) {
            logger.warn(`Не удалось собрать сценарий через AI, используем запасной вариант: ${error.message}`);
            scriptContent = ai.buildFallbackScript(hotelData);
            logger.debug(`Fallback script created from catch block for scenario ${scenarioId}: length=${scriptContent?.length || 0}`);
        }

        if (!scriptContent) {
            logger.warn('AI вернул пустой сценарий, используем запасной вариант');
            scriptContent = ai.buildFallbackScript(hotelData);
            logger.debug(`Fallback script created after empty AI response for scenario ${scenarioId}: length=${scriptContent?.length || 0}`);
        }

        logger.info('Шаг 6/6: сохраняем результат и отправляем email');
        await db.updateScriptStatus(scenarioId, 'completed', scriptContent);
        logger.info(`Сценарий готов: ${scenarioId}`);

        try {
            const targetEmail = hotelData.contact_email || config.GUEST_USER_EMAIL || 'akrohaleva67@gmail.com';
            logger.info(`Отправляем сценарий на ${targetEmail}`);
            await email.sendEmail(targetEmail, `Video Script: ${hotelData.hotel_name}`, scriptContent);
            logger.info('Email отправлен');
        } catch (emailErr) {
            logger.error(`Email Step Failed: ${emailErr.message}`);
        }

        logger.info(`Готово: ${hotelData.hotel_name}`);
    } catch (err) {
        logger.error(`Ошибка обработки ${hotelLogName}: ${err.message}`);
        if (scriptRecord?.id) {
            try {
                await db.updateScriptStatus(scriptRecord.id, 'failed');
            } catch (statusErr) {
                logger.error(`Не удалось обновить статус сценария: ${statusErr.message}`);
            }
        }

        logger.error(`Критическая ошибка: ${err.message}`);
    }
}

function startWorker() {
    logger.info('Воркер запущен');
    consumeFromQueue(processHotelData);
    logger.info('Ожидаем новые запросы');
}

module.exports = { startWorker };
