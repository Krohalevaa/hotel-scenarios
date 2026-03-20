const axios = require('axios');
const config = require('./config');
const logger = require('./logger');

async function executeClickHouseQuery(query) {
    try {
        await axios.post(config.CLICKHOUSE_URL, query, {
            headers: {
                'Authorization': `Basic ${config.CLICKHOUSE_AUTH_BASE64}`,
                'Content-Type': 'text/plain'
            }
        });
        logger.info("Saved to ClickHouse successfully.");
    } catch (error) {
        logger.error(`ClickHouse error: ${error.response?.data || error.message}`);
    }
}

async function saveAttractions(hotelName, attractions) {
    if (!attractions || attractions.length === 0) return;
    const safeHotel = hotelName.replace(/'/g, "''");
    // attractions теперь ожидает массив строк (для старой таблицы)
    const values = attractions.map(a => `('${safeHotel}', '${(typeof a === 'string' ? a : a.name).replace(/'/g, "''")}')`).join(',');
    const sql = `INSERT INTO hotel_attractions (hotel_name, attraction_name) VALUES ${values}`;
    await executeClickHouseQuery(sql);
}

async function saveCategorizedPois(hotelName, pois) {
    if (!pois || pois.length === 0) return;
    const safeHotel = hotelName.replace(/'/g, "''");
    const values = pois.map(p => `('${safeHotel}', '${p.name.replace(/'/g, "''")}', '${p.category.replace(/'/g, "''")}')`).join(',');
    const sql = `INSERT INTO hotel_poi (hotel_name, poi_name, category) VALUES ${values}`;
    await executeClickHouseQuery(sql);
}

module.exports = { executeClickHouseQuery, saveAttractions, saveCategorizedPois };
