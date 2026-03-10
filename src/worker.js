const { consumeFromQueue } = require('./rabbitmq');
const { getGeoCoordinates, searchAttractions } = require('./geo');
const { saveAttractions, executeClickHouseQuery } = require('./db');
const { generateSchemaSQL, generateScript } = require('./ai');
const { sendEmail } = require('./email');

async function processHotelData(hotelData) {
    console.log("Processing hotel:", hotelData.hotel_name);

    // 1. Geocoding
    const geoData = await getGeoCoordinates(hotelData.hotel_name, hotelData.city);
    hotelData.geo_lat = geoData.geo_lat;
    hotelData.geo_lon = geoData.geo_lon;
    hotelData._geo_debug_name = geoData._geo_debug_name;

    // 2. Attractions
    if (hotelData.geo_lat && hotelData.geo_lon) {
        const attractions = await searchAttractions(hotelData.geo_lat, hotelData.geo_lon);
        hotelData.nearby_attractions = attractions;

        if (attractions.length > 0) {
            await saveAttractions(hotelData.hotel_name, attractions);
        }
    }

    // 3. Generate Schema SQL (AI: Schema Mapper) and Save to CH (CH: Save Hotel Profile)
    const sql = await generateSchemaSQL(hotelData);
    if (sql) {
        await executeClickHouseQuery(sql);
    }

    // 4. Generate Script (AI: Script Writer) and Email (Email: Send Script to Client)
    const scriptContent = await generateScript(hotelData);
    if (scriptContent && hotelData.contact_email) {
        await sendEmail(hotelData.contact_email, "Scenario", scriptContent);
    }

    console.log("Finished processing hotel:", hotelData.hotel_name);
}

function startWorker() {
    consumeFromQueue(processHotelData);
    console.log("Worker started, listening for messages...");
}

module.exports = { startWorker };
