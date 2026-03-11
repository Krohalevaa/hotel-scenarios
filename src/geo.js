const axios = require('axios');
const logger = require('./logger');

// Шаг 1: Настройка Axios инстанса
const geoAxios = axios.create({
    headers: {
        'User-Agent': 'HotelScenarioGenerator/2.0 (akrohaleva67@gmail.com)'
    }
});

// Шаг 2: Внедрение Retry Pattern
async function fetchWithRetry(requestFn, maxRetries = 3) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await requestFn();
        } catch (err) {
            const status = err.response?.status;
            const shouldRetry = status === 429 || (status >= 500 && status <= 504);

            if (shouldRetry && attempt < maxRetries) {
                const delay = Math.pow(2, attempt) * 1000;
                logger.warn(`Retry attempt ${attempt + 1} after ${delay}ms due to status ${status}`);
                await new Promise(resolve => setTimeout(resolve, delay));
                continue;
            }
            throw err;
        }
    }
}

// Шаг 3: Агрессивная фильтрация (Sanitization) стоп-слов
function sanitizeHotelName(name) {
    if (!name) return "";

    logger.debug(`Sanitizing hotel name: "${name}"`);
    // 1. Убираем протоколы, www и доменные зоны
    let clean = name.replace(/^(https?:\/\/)?(www\.)?/i, '');
    clean = clean.split('/')[0].replace(/\.(com|net|org|biz|info|gov|edu|me|tv|io|ru|us|uk|ca|site)(\..+)?$/i, '');

    // 2. Список стоп-слов для удаления маркетингового мусора
    const stopWords = [
        'Hotel', 'Resort', 'Spa', 'LLC', 'Inn', 'Suites', 'Boutique',
        'Luxury', 'Near', 'Central', 'Park', 'Exclusive', 'Stay',
        'Vacation', 'Experience', 'Iconic', 'Premium', 'Best',
        'Official', 'Site', 'Welcome', 'Classic'
    ];

    const regexStopWords = new RegExp(`\\b(${stopWords.join('|')})\\b`, 'gi');

    clean = clean
        .replace(regexStopWords, '')
        .replace(/[._\-+,]/g, ' ') // Заменяем спецсимволы на пробелы
        .replace(/\s+/g, ' ')
        .trim();

    logger.debug(`Sanitized result: "${clean}"`);
    return clean;
}

// Поиск координат города (высокая точность)
async function getCityCoordinates(city) {
    logger.info(`Geocoding City: "${city}"...`);
    try {
        const response = await fetchWithRetry(() => geoAxios.get('https://nominatim.openstreetmap.org/search', {
            params: { city: city, format: 'json', limit: 1 },
            timeout: 5000
        }));
        if (response.data[0]) {
            logger.info(`City "${city}" found at [${response.data[0].lat}, ${response.data[0].lon}]`);
            return { lat: response.data[0].lat, lon: response.data[0].lon };
        }
        logger.warn(`City "${city}" NOT found.`);
        return null;
    } catch (err) {
        logger.error(`City search error for ${city}: ${err.message}`);
        return null;
    }
}

// Поиск отеля через Overpass API в радиусе города
async function searchHotelInRadius(name, cityLat, cityLon, radius = 20000) {
    if (!name || name.length < 3) {
        logger.warn(`Name "${name}" too short for Overpass search.`);
        return null;
    }

    logger.info(`Searching hotel "${name}" via Overpass API in ${radius}m radius...`);
    // Регулярка для нечувствительного к регистру поиска по части названия
    const cleanQuery = name.replace(/['"\\/]/g, '');
    const query = `
        [out:json][timeout:25];
        (
          node["tourism"~"hotel|resort|guest_house|hostel"]["name"~"${cleanQuery}",i](around:${radius},${cityLat},${cityLon});
          way["tourism"~"hotel|resort|guest_house|hostel"]["name"~"${cleanQuery}",i](around:${radius},${cityLat},${cityLon});
          relation["tourism"~"hotel|resort|guest_house|hostel"]["name"~"${cleanQuery}",i](around:${radius},${cityLat},${cityLon});
        );
        out center 1;
    `;

    try {
        const response = await fetchWithRetry(() => axios.post('https://overpass-api.de/api/interpreter', query, {
            headers: { 'Content-Type': 'text/plain' },
            timeout: 10000
        }));

        const element = response.data.elements?.[0];
        if (element) {
            const lat = element.lat || element.center?.lat;
            const lon = element.lon || element.center?.lon;
            logger.info(`Overpass matched: "${element.tags?.name}" at [${lat}, ${lon}]`);
            return {
                lat: lat,
                lon: lon,
                name: element.tags?.name || name
            };
        }
        logger.warn(`No hotel found via Overpass for "${name}".`);
        return null;
    } catch (err) {
        logger.error(`Overpass hotel search error for ${name}: ${err.message}`);
        return null;
    }
}

async function getGeoCoordinates(hotelName, city) {
    const cleanHotelName = sanitizeHotelName(hotelName);

    // Шаг 1: Находим город
    const cityCoords = await getCityCoordinates(city);

    if (cityCoords) {
        // Шаг 2: Ищем конкретный отель через Overpass в радиусе города
        const hotel = await searchHotelInRadius(cleanHotelName, cityCoords.lat, cityCoords.lon);

        if (hotel) {
            return {
                geo_lat: parseFloat(hotel.lat),
                geo_lon: parseFloat(hotel.lon),
                _geo_debug_name: `${hotel.name} (Overpass Precision)`
            };
        }

        // Шаг 3: Если Overpass не нашел или завис, пробуем быстрый свободный поиск Nominatim
        logger.info(`Attempting Nominatim fallback for "${cleanHotelName}" in ${city}...`);
        try {
            const nominatimResponse = await fetchWithRetry(() => geoAxios.get('https://nominatim.openstreetmap.org/search', {
                params: {
                    q: `${cleanHotelName}, ${city}`,
                    format: 'json',
                    limit: 1
                },
                timeout: 5000
            }));

            const osmData = nominatimResponse.data[0];
            if (osmData) {
                logger.info(`Nominatim fallback found: "${osmData.display_name}"`);
                return {
                    geo_lat: parseFloat(osmData.lat),
                    geo_lon: parseFloat(osmData.lon),
                    _geo_debug_name: `${osmData.display_name} (Nominatim Fallback)`
                };
            }
        } catch (err) {
            logger.error(`Nominatim fallback error: ${err.message}`);
        }

        // Шаг 4: Если совсем ничего — центр города
        logger.warn(`Using City Center fallback for "${cleanHotelName}".`);
        return {
            geo_lat: parseFloat(cityCoords.lat),
            geo_lon: parseFloat(cityCoords.lon),
            _geo_debug_name: `${city} Center (Fallback)`
        };
    }

    logger.error(`Could not proceed with geocoding for "${hotelName}" because city coordinates are null.`);
    return { geo_lat: null, geo_lon: null, _geo_debug_name: null };
}

async function searchAttractions(lat, lon) {
    if (!lat || !lon) return [];

    logger.debug(`Searching attractions around [${lat}, ${lon}]...`);
    const query = `
      [out:json][timeout:90];
      (
        node["tourism"~"museum|gallery|attraction|theme_park"](around:2000,${lat},${lon});
        way["tourism"~"museum|gallery|attraction|theme_park"](around:2000,${lat},${lon});
        node["historic"~"monument|memorial|castle"](around:2000,${lat},${lon});
      );
      out tags 10;
    `;

    try {
        const response = await fetchWithRetry(() => axios.post('https://overpass-api.de/api/interpreter', query, {
            headers: { 'Content-Type': 'text/plain' },
            timeout: 15000
        }));

        const elements = response.data.elements || [];
        const pois = elements
            .map(el => el.tags && (el.tags.name || el.tags['name:en']))
            .filter(Boolean);

        const results = [...new Set(pois)].slice(0, 5);
        logger.debug(`Found attractions: ${results.join(', ')}`);
        return results;
    } catch (err) {
        logger.error(`Attractions search error: ${err.message}`);
        return [];
    }
}

module.exports = { getGeoCoordinates, searchAttractions };
