const axios = require('axios');
const config = require('./config');

async function executeClickHouseQuery(query) {
    try {
        await axios.post(config.CLICKHOUSE_URL, query, {
            headers: {
                'Authorization': `Basic ${config.CLICKHOUSE_AUTH_BASE64}`,
                'Content-Type': 'text/plain'
            }
        });
        console.log("Saved to ClickHouse successfully.");
    } catch (error) {
        console.error("ClickHouse error:", error.response?.data || error.message);
    }
}

async function saveAttractions(hotelName, attractions) {
    if (!attractions || attractions.length === 0) return;
    const safeHotel = hotelName.replace(/'/g, "''");
    const values = attractions.map(a => `('${safeHotel}', '${a.replace(/'/g, "''")}')`).join(',');
    const sql = `INSERT INTO hotel_attractions (hotel_name, attraction_name) VALUES ${values}`;
    await executeClickHouseQuery(sql);
}

module.exports = { executeClickHouseQuery, saveAttractions };
