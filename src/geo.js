const axios = require('axios');

async function getGeoCoordinates(hotelName, city) {
    try {
        const q = `${hotelName.split(',')[0].trim()}, ${city}`;
        const response = await axios.get('https://nominatim.openstreetmap.org/search', {
            params: { q, format: 'json', limit: 1 },
            headers: { 'User-Agent': 'n8n-hotel-workflow-clone/1.0' }
        });
        const osmData = response.data[0] || {};
        return {
            geo_lat: osmData.lat ? parseFloat(osmData.lat) : null,
            geo_lon: osmData.lon ? parseFloat(osmData.lon) : null,
            _geo_debug_name: osmData.display_name || "Not found"
        };
    } catch (err) {
        console.error("Geo search error:", err.message);
        return { geo_lat: null, geo_lon: null, _geo_debug_name: null };
    }
}

async function searchAttractions(lat, lon) {
    if (!lat || !lon) return [];
    try {
        const query = `
      [out:json][timeout:90];
      (
        node["tourism"~"museum|gallery|attraction|theme_park"](around:2000,${lat},${lon});
        way["tourism"~"museum|gallery|attraction|theme_park"](around:2000,${lat},${lon});
        node["historic"~"monument|memorial|castle"](around:2000,${lat},${lon});
      );
      out tags 10;
    `;
        const response = await axios.post('https://overpass-api.de/api/interpreter', query, {
            headers: { 'Content-Type': 'text/plain' }
        });

        const elements = response.data.elements || [];
        const pois = elements
            .map(el => el.tags && (el.tags.name || el.tags['name:en']))
            .filter(Boolean);

        return [...new Set(pois)].slice(0, 5);
    } catch (err) {
        console.error("Attractions search error:", err.message);
        return [];
    }
}

module.exports = { getGeoCoordinates, searchAttractions };
