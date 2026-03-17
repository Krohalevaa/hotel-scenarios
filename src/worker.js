const { consumeFromQueue } = require('./rabbitmq');
const { getGeoCoordinates, searchAttractions } = require('./geo');
const { saveAttractions, saveCategorizedPois, executeClickHouseQuery } = require('./db');
const { generateSchemaSQL, generateScript, extractCleanHotelName, predictOsmHotelData } = require('./ai');
const { sendEmail } = require('./email');
const logger = require('./logger');

async function processHotelData(hotelData) {
    logger.info(`=== Starting processing for hotel: "${hotelData.hotel_name}" ===`);

    try {
        // 1. Geocoding
        logger.info('Step 1: Starting Geocoding process...');
        
        // AI: Извлекаем чистое название отеля для начала
        const cleanName = await extractCleanHotelName(hotelData.hotel_name, hotelData.hotel_website_url) || hotelData.hotel_name;
        logger.info(`AI Cleaned Name: "${hotelData.hotel_name}" -> "${cleanName}"`);

        // NEW: Предсказание официального названия для OSM и БД через ИИ
        logger.info('Predicting official hotel name via AI...');
        const osmPrediction = await predictOsmHotelData(cleanName, hotelData.city, hotelData.hotel_website_url);
        
        // КРИТИЧЕСКОЕ ИЗМЕНЕНИЕ: Перезаписываем название отеля на официальное
        const originalName = hotelData.hotel_name;
        hotelData.hotel_name = osmPrediction.osm_target_name || cleanName;
        logger.info(`Canonical Hotel Name set: "${originalName}" -> "${hotelData.hotel_name}"`);

        const geoData = await getGeoCoordinates(hotelData.hotel_name, hotelData.city, hotelData.hotel_website_url, osmPrediction);
        hotelData.geo_lat = geoData.geo_lat;
        hotelData.geo_lon = geoData.geo_lon;
        hotelData.address = geoData.address;
        hotelData._geo_debug_name = geoData._geo_debug_name;
        logger.info(`Geocoding finished. Result: ${geoData._geo_debug_name} [${geoData.geo_lat}, ${geoData.geo_lon}]`);

        // Sanity Check: Если всё ещё нет координат, пробуем вытащить по городу
        if (!hotelData.geo_lat || !hotelData.geo_lon) {
            logger.warn('Critical: Geocoding returned no coordinates. Applying final safety fallback...');
            const { getCityCoordinates } = require('./geo');
            const cityFallback = await getCityCoordinates(hotelData.city);
            if (cityFallback) {
                hotelData.geo_lat = cityFallback.lat;
                hotelData.geo_lon = cityFallback.lon;
                hotelData.address = hotelData.city;
                hotelData._geo_debug_name = `${hotelData.city} (City Center Fallback)`;
            }
        }

        // 2. Attractions - ТЕПЕРЬ ПОСЛЕ ФОЛЛБЭКА
        if (hotelData.geo_lat && hotelData.geo_lon) {
            logger.info('Step 2: Searching for nearby attractions...');
            const attractions = await searchAttractions(hotelData.geo_lat, hotelData.geo_lon);
            // Для ИИ-скрипта оставляем только имена для простоты контекста
            hotelData.nearby_attractions = attractions.map(a => a.name);
            logger.info(`Found ${attractions.length} attractions.`);

            if (attractions.length > 0) {
                logger.info('Saving categorized POIs to database (hotel_poi)...');
                await saveCategorizedPois(hotelData.hotel_name, attractions);

                // Также сохраняем в старую таблицу для совместимости (только имена)
                await saveAttractions(hotelData.hotel_name, attractions);
            }
        } else {
            logger.warn('Skipping attractions search because coordinates are missing.');
        }

        // 3. Generate Schema SQL
        logger.info('Step 3: Generating SQL via AI...');
        let sql = await generateSchemaSQL(hotelData);
        
        if (!sql) {
            logger.warn('AI failed to generate SQL. Using basic fallback SQL...');
            const safeName = hotelData.hotel_name.replace(/'/g, "''");
            const safeDomain = (hotelData.hotel_website_url || "").replace(/https?:\/\//, "").split('/')[0];
            const safeCity = (hotelData.city || "Unknown").replace(/'/g, "''");
            const safeUrl = (hotelData.hotel_website_url || "").replace(/'/g, "''");
            
            sql = `INSERT INTO hotel_profile (hotel_name, hotel_domain, city, geo_lat, geo_lon, source_url, source_captured_at, core_description, hotel_type) 
                   VALUES ('${safeName}', '${safeDomain}', '${safeCity}', ${hotelData.geo_lat || 'NULL'}, ${hotelData.geo_lon || 'NULL'}, '${safeUrl}', now(), 'Data recovery: AI generation failed.', 'boutique')`;
        }

        if (sql) {
            logger.info('Executing SQL query in ClickHouse...');
            await executeClickHouseQuery(sql);
            logger.info('SQL execution successful.');
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
