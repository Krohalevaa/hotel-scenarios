const axios = require('axios');
const logger = require('./logger');

// Шаг 1: Настройка Axios инстанса
const geoAxios = axios.create({
    headers: {
        'User-Agent': 'HotelScenarioGenerator/2.0 (akrohaleva67@gmail.com)'
    }
});

// Добавляем кэш для городов и хелпер для паузы
const cityCache = new Map([
    ["New York", { lat: 40.7128, lon: -74.0060 }],
    ["London", { lat: 51.5074, lon: -0.1278 }],
    ["Paris", { lat: 48.8566, lon: 2.3522 }],
    ["Las Vegas", { lat: 36.1716, lon: -115.1391 }],
    ["Los Angeles", { lat: 34.0522, lon: -118.2437 }],
    ["Chicago", { lat: 41.8781, lon: -87.6298 }],
    ["Washington DC", { lat: 38.9072, lon: -77.0369 }],
    ["Miami Beach", { lat: 25.7907, lon: -80.1300 }]
]);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Шаг 2: Внедрение Retry Pattern
async function fetchWithRetry(requestFn, maxRetries = 3) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await requestFn();
        } catch (err) {
            const status = err.response?.status;
            const shouldRetry = status === 429 || (status >= 500 && status <= 504);

            if (shouldRetry && attempt < maxRetries) {
                // Более агрессивное ожидание для 429 (Rate Limit)
                const delay = (status === 429 ? 10000 : 2000) * Math.pow(2, attempt);
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

    // 2. Список стоп-слов для удаления маркетингового мусора (уменьшаем агрессивность)
    const stopWords = [
        'LLC', 'Exclusive', 'Stay', 'Near', 'Central', 'Park',
        'Official', 'Site', 'Welcome', 'Classic', 'Premium', 'Best'
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

// Поиск координат города (с кэшированием)
async function getCityCoordinates(city) {
    if (!city) return null;
    
    // Проверка кэша
    if (cityCache.has(city)) {
        logger.debug(`City "${city}" found in cache.`);
        return cityCache.get(city);
    }

    logger.info(`Geocoding City: "${city}"...`);
    try {
        // Принудительная пауза перед запросом к Nominatim
        await sleep(1500);
        const response = await fetchWithRetry(() => geoAxios.get('https://nominatim.openstreetmap.org/search', {
            params: { city: city, format: 'json', limit: 1 },
            timeout: 5000
        }));
        if (response.data[0]) {
            const coords = { lat: response.data[0].lat, lon: response.data[0].lon };
            logger.info(`City "${city}" found at [${coords.lat}, ${coords.lon}]`);
            cityCache.set(city, coords); // Сохраняем в кэш
            return coords;
        }
        logger.warn(`City "${city}" NOT found.`);
        return null;
    } catch (err) {
        logger.error(`City search error for ${city}: ${err.message}`);
        return null;
    }
}

// Поиск отеля через Overpass API в радиусе города
async function searchHotelInRadius(name, cityLat, cityLon, radius = 20000, website = '') {
    if ((!name || name.length < 3) && !website) {
        logger.warn(`Search parameters too weak: name="${name}", website="${website}"`);
        return null;
    }

    logger.info(`Searching hotel "${name}" ${website ? `(site: ${website})` : ''} via Overpass in ${radius}m radius...`);
    
    // Регулярка для нечувствительного к регистру поиска по части названия
    const cleanName = (name || "").replace(/['"\\/]/g, '');
    const domainPart = website ? website.replace(/https?:\/\//, '').replace(/^www\./, '').split('/')[0] : '';
    
    let query = `[out:json][timeout:25];(`;
    
    if (cleanName.length >= 3) {
        query += `
          node["tourism"~"hotel|resort|guest_house|hostel"]["name"~"${cleanName}",i](around:${radius},${cityLat},${cityLon});
          way["tourism"~"hotel|resort|guest_house|hostel"]["name"~"${cleanName}",i](around:${radius},${cityLat},${cityLon});
          relation["tourism"~"hotel|resort|guest_house|hostel"]["name"~"${cleanName}",i](around:${radius},${cityLat},${cityLon});
        `;
    }
    
    if (domainPart) {
        query += `
          node["tourism"~"hotel|resort|guest_house|hostel"]["website"~"${domainPart}",i](around:${radius},${cityLat},${cityLon});
          way["tourism"~"hotel|resort|guest_house|hostel"]["website"~"${domainPart}",i](around:${radius},${cityLat},${cityLon});
          relation["tourism"~"hotel|resort|guest_house|hostel"]["website"~"${domainPart}",i](around:${radius},${cityLat},${cityLon});
          node["tourism"~"hotel|resort|guest_house|hostel"]["contact:website"~"${domainPart}",i](around:${radius},${cityLat},${cityLon});
        `;
    }
    
    query += `); out center 1;`;

    try {
        // Принудительная пауза перед Overpass
        await sleep(1500);
        const response = await fetchWithRetry(() => axios.post('https://overpass-api.de/api/interpreter', query, {
            headers: { 'Content-Type': 'text/plain' },
            timeout: 30000 // Увеличиваем до 30с
        }));

        const element = response.data.elements?.[0];
        if (element) {
            const lat = element.lat || element.center?.lat;
            const lon = element.lon || element.center?.lon;
            logger.info(`Overpass matched: "${element.tags?.name}" at [${lat}, ${lon}]`);
            return {
                lat: lat,
                lon: lon,
                name: element.tags?.name || name,
                address: element.tags?.['addr:full'] || element.tags?.['addr:street'] || null
            };
        }
        logger.warn(`No hotel found via Overpass for "${name}" / "${domainPart}".`);
        return null;
    } catch (err) {
        logger.error(`Overpass hotel search error for ${name}: ${err.message}`);
        return null;
    }
}

async function getGeoCoordinates(hotelName, city, hotelWebsite = '', osmPrediction = null) {
    const cleanHotelName = sanitizeHotelName(hotelName);
    const aiOsmName = osmPrediction?.osm_target_name || '';

    // Шаг 1: Находим координаты города сразу
    const cityCoords = await getCityCoordinates(city);
    if (!cityCoords) {
        logger.error(`Could not proceed with geocoding for "${hotelName}" because city coordinates are null.`);
        return { geo_lat: null, geo_lon: null, address: null, _geo_debug_name: null };
    }

    // Список стратегий поиска (от наиболее точных к менее точным)
    const strategies = [
        // 1. Overpass: LLM Name + Website
        { 
            name: "Overpass (AI Name + Website)", 
            fn: () => searchHotelInRadius(aiOsmName, cityCoords.lat, cityCoords.lon, 20000, hotelWebsite) 
        },
        // 2. Overpass: LLM Name only
        { 
            name: "Overpass (AI Name)", 
            fn: () => searchHotelInRadius(aiOsmName, cityCoords.lat, cityCoords.lon, 20000) 
        },
        // 3. Overpass: Clean Sanitized Name + Website
        { 
            name: "Overpass (Sanitized + Website)", 
            fn: () => searchHotelInRadius(cleanHotelName, cityCoords.lat, cityCoords.lon, 20000, hotelWebsite) 
        },
        // 4. Nominatim: LLM Name
        { 
            name: "Nominatim (AI Name)", 
            fn: async () => {
                await sleep(1000);
                const resp = await fetchWithRetry(() => geoAxios.get('https://nominatim.openstreetmap.org/search', {
                    params: { q: `${aiOsmName}, ${city}`, format: 'json', limit: 1 },
                    timeout: 5000
                }));
                const d = resp.data[0];
                return d ? { lat: d.lat, lon: d.lon, name: d.display_name } : null;
            }
        },
        // 5. Nominatim: Clean Sanitized Name
        { 
            name: "Nominatim (Sanitized Name)", 
            fn: async () => {
                await sleep(1000);
                const resp = await fetchWithRetry(() => geoAxios.get('https://nominatim.openstreetmap.org/search', {
                    params: { q: `${cleanHotelName}, ${city}`, format: 'json', limit: 1 },
                    timeout: 5000
                }));
                const d = resp.data[0];
                return d ? { lat: d.lat, lon: d.lon, name: d.display_name } : null;
            }
        }
    ];

    for (const strategy of strategies) {
        try {
            await sleep(2000); // Обязательная пауза между стратегиями
            logger.debug(`Executing geocoding strategy: ${strategy.name}`);
            const result = await strategy.fn();
            if (result && result.lat && result.lon) {
                // Проверка: не вернул ли нам Nominatim просто координаты города? (обычно если имя совсем не подошло)
                const isCityCenter = Math.abs(parseFloat(result.lat) - cityCoords.lat) < 0.001 && 
                                   Math.abs(parseFloat(result.lon) - cityCoords.lon) < 0.001;
                
                if (!isCityCenter) {
                    logger.info(`Strategy "${strategy.name}" SUCCESS: [${result.lat}, ${result.lon}]`);
                    return {
                        geo_lat: parseFloat(result.lat),
                        geo_lon: parseFloat(result.lon),
                        address: result.address || result.name,
                        _geo_debug_name: `${result.name || hotelName} (${strategy.name})`
                    };
                }
                logger.debug(`Strategy "${strategy.name}" returned city center, skipping...`);
            }
        } catch (err) {
            logger.error(`Strategy "${strategy.name}" failed: ${err.message}`);
        }
    }

    // Финальный фоллбэк - Центр города
    logger.warn(`All geocoding strategies failed for "${hotelName}". Using City Center fallback.`);
    return {
        geo_lat: parseFloat(cityCoords.lat),
        geo_lon: parseFloat(cityCoords.lon),
        address: city,
        _geo_debug_name: `${city} Center (Final Fallback)`
    };
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
        const results = elements
            .map(el => {
                const tags = el.tags || {};
                const name = tags.name || tags['name:en'];
                if (!name) return null;

                // Определяем категорию на основе тегов OSM
                let category = 'Other';
                if (tags.tourism === 'zoo') category = 'Zoo';
                else if (tags.tourism === 'artwork') category = 'Monument/Art';
                else if (tags.tourism === 'museum') category = 'Museum';
                else if (tags.tourism === 'attraction') category = 'Attraction';
                else if (tags.historic) category = 'Historic';
                else if (tags.tourism) category = tags.tourism.charAt(0).toUpperCase() + tags.tourism.slice(1);

                return { name, category };
            })
            .filter(Boolean);

        // Убираем дубликаты по имени
        const uniqueResults = [];
        const seenNames = new Set();
        for (const item of results) {
            if (!seenNames.has(item.name)) {
                seenNames.add(item.name);
                uniqueResults.push(item);
            }
        }

        const finalResults = uniqueResults.slice(0, 5);
        logger.debug(`Found attractions: ${finalResults.map(r => `${r.name} (${r.category})`).join(', ')}`);
        return finalResults;
    } catch (err) {
        logger.error(`Attractions search error: ${err.message}`);
        return [];
    }
}

module.exports = { getGeoCoordinates, searchAttractions };
