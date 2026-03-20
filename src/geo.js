const axios = require('axios');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

// Шаг 1: Настройка Axios инстанса
const geoAxios = axios.create({
    headers: {
        'User-Agent': 'HotelScenarioGenerator/2.0 (akrohaleva67@gmail.com)'
    }
});

// Task 8: Persistent City Cache
const CITY_CACHE_FILE = path.join(__dirname, '../city_cache.json');
let cityCache = new Map([
    ["New York", { lat: 40.7128, lon: -74.0060 }],
    ["London", { lat: 51.5074, lon: -0.1278 }],
    ["Paris", { lat: 48.8566, lon: 2.3522 }],
    ["Las Vegas", { lat: 36.1716, lon: -115.1391 }],
    ["Los Angeles", { lat: 34.0522, lon: -118.2437 }],
    ["Chicago", { lat: 41.8781, lon: -87.6298 }],
    ["Washington DC", { lat: 38.9072, lon: -77.0369 }],
    ["Miami Beach", { lat: 25.7907, lon: -80.1300 }]
]);

function loadCityCache() {
    try {
        if (fs.existsSync(CITY_CACHE_FILE)) {
            const data = JSON.parse(fs.readFileSync(CITY_CACHE_FILE, 'utf8'));
            Object.entries(data).forEach(([city, coords]) => cityCache.set(city, coords));
            logger.info(`Loaded ${Object.keys(data).length} cities from persistent cache.`);
        }
    } catch (err) {
        logger.error(`Error loading city cache: ${err.message}`);
    }
}

function saveCityCache() {
    try {
        const data = Object.fromEntries(cityCache);
        fs.writeFileSync(CITY_CACHE_FILE, JSON.stringify(data, null, 2));
    } catch (err) {
        logger.error(`Error saving city cache: ${err.message}`);
    }
}

loadCityCache();

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Шаг 2: Внедрение Retry Pattern
async function fetchWithRetry(requestFn, maxRetries = 3) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await requestFn();
        } catch (err) {
            const status = err.response?.status;
            // Overpass often returns 504 on heavy load
            const shouldRetry = status === 429 || (status >= 500 && status <= 504);

            if (shouldRetry && attempt < maxRetries) {
                // Более агрессивное ожидание для 429 (Rate Limit) и 504 (Timeout)
                const delay = (status === 429 ? 15000 : 3000) * Math.pow(2, attempt);
                logger.warn(`Retry attempt ${attempt + 1} after ${delay}ms due to status ${status}`);
                await new Promise(resolve => setTimeout(resolve, delay));
                continue;
            }
            throw err;
        }
    }
}

// Task 6: Refined Sanitization (removed 'Park' and 'Central')
function sanitizeHotelName(name) {
    if (!name) return "";

    logger.debug(`Sanitizing hotel name: "${name}"`);
    // 1. Убираем протоколы, www и доменные зоны
    let clean = name.replace(/^(https?:\/\/)?(www\.)?/i, '');
    clean = clean.split('/')[0].replace(/\.(com|net|org|biz|info|gov|edu|me|tv|io|ru|us|uk|ca|site)(\..+)?$/i, '');

    // 2. Список стоп-слов/фраз для удаления маркетингового мусора
    const stopPhrases = [
        'Official Site', 'Official Website', 'Best Rate Guaranteed',
        'Exclusive Stay', 'Welcome to', 'LLC', 'Premium', 'Classic'
    ];

    const regexStopWords = new RegExp(`\\b(${stopPhrases.join('|')})\\b`, 'gi');

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
            timeout: 7000
        }));
        if (response.data[0]) {
            const coords = { lat: response.data[0].lat, lon: response.data[0].lon };
            logger.info(`City "${city}" found at [${coords.lat}, ${coords.lon}]`);
            cityCache.set(city, coords); // Сохраняем в кэш
            saveCityCache(); // Persistence
            return coords;
        }
        logger.warn(`City "${city}" NOT found.`);
        return null;
    } catch (err) {
        logger.error(`City search error for ${city}: ${err.message}`);
        return null;
    }
}

// Task 15: Optimize Overpass search (Exact name first)
async function searchHotelInRadius(name, cityLat, cityLon, radius = 20000, website = '') {
    if ((!name || name.length < 3) && !website) {
        logger.warn(`Search parameters too weak: name="${name}", website="${website}"`);
        return null;
    }

    logger.info(`Searching hotel "${name}" ${website ? `(site: ${website})` : ''} via Overpass in ${radius}m radius...`);
    
    const cleanName = (name || "").replace(/['"\\/]/g, '');
    const domainPart = website ? website.replace(/https?:\/\//, '').replace(/^www\./, '').split('/')[0] : '';
    
    // Strategy 1: Exact name match (Much faster)
    const exactQuery = `[out:json][timeout:30];(
        node["tourism"~"hotel|resort|guest_house|hostel"]["name"="${cleanName}"](around:${radius},${cityLat},${cityLon});
        way["tourism"~"hotel|resort|guest_house|hostel"]["name"="${cleanName}"](around:${radius},${cityLat},${cityLon});
    ); out center 1;`;

    // Strategy 2: Regexp/Website match (Slower fallback)
    const regexQuery = `[out:json][timeout:30];(` +
        (cleanName.length >= 3 ? `
          node["tourism"~"hotel|resort|guest_house|hostel"]["name"~"${cleanName}",i](around:${radius},${cityLat},${cityLon});
          way["tourism"~"hotel|resort|guest_house|hostel"]["name"~"${cleanName}",i](around:${radius},${cityLat},${cityLon});
        ` : '') +
        (domainPart ? `
          node["tourism"~"hotel|resort|guest_house|hostel"]["website"~"${domainPart}",i](around:${radius},${cityLat},${cityLon});
          way["tourism"~"hotel|resort|guest_house|hostel"]["website"~"${domainPart}",i](around:${radius},${cityLat},${cityLon});
          node["tourism"~"hotel|resort|guest_house|hostel"]["contact:website"~"${domainPart}",i](around:${radius},${cityLat},${cityLon});
        ` : '') +
        `); out center 1;`;

    const queries = [exactQuery, regexQuery];

    for (let q = 0; q < queries.length; q++) {
        try {
            await sleep(1500);
            logger.debug(`Executing Overpass Query Layer ${q + 1}...`);
            const response = await fetchWithRetry(() => axios.post('https://overpass-api.de/api/interpreter', queries[q], {
                headers: { 'Content-Type': 'text/plain' },
                timeout: 35000
            }));

            const element = response.data.elements?.[0];
            if (element) {
                const lat = element.lat || element.center?.lat;
                const lon = element.lon || element.center?.lon;
                logger.info(`Overpass matched (Layer ${q + 1}): "${element.tags?.name}" at [${lat}, ${lon}]`);
                return {
                    lat: lat,
                    lon: lon,
                    name: element.tags?.name || name,
                    address: element.tags?.['addr:full'] || element.tags?.['addr:street'] || null
                };
            }
        } catch (err) {
            logger.error(`Overpass Layer ${q + 1} error: ${err.message}`);
        }
    }
    logger.warn(`No hotel found via Overpass for "${name}" / "${domainPart}".`);
    return null;
}

// Task 3: Nominatim Accuracy filtering
async function nominatimSearch(query, city) {
    try {
        await sleep(1500);
        const resp = await fetchWithRetry(() => geoAxios.get('https://nominatim.openstreetmap.org/search', {
            params: { q: `${query}, ${city}`, format: 'json', limit: 5 },
            timeout: 8000
        }));

        if (!resp.data || resp.data.length === 0) return null;

        // Filter for hotel-like buildings first
        const matched = resp.data.find(item => 
            ['hotel', 'resort', 'guest_house', 'hostel', 'motel', 'tourism'].includes(item.type) ||
            item.class === 'tourism' ||
            (item.class === 'building' && item.type === 'yes')
        );

        const d = matched || resp.data[0];
        return { lat: d.lat, lon: d.lon, name: d.display_name };
    } catch (err) {
        logger.error(`Nominatim search error: ${err.message}`);
        return null;
    }
}

async function getGeoCoordinates(hotelName, city, hotelWebsite = '', osmPrediction = null) {
    const cleanHotelName = sanitizeHotelName(hotelName);
    const aiOsmName = osmPrediction?.osm_target_name || '';

    // Шаг 1: Находим координаты города сразу
    const cityCoords = await getCityCoordinates(city);
    if (!cityCoords) {
        logger.error(`Geocoding aborted for "${hotelName}": city coords missing.`);
        return { geo_lat: null, geo_lon: null, address: null, _geo_debug_name: null };
    }

    // Список стратегий поиска (от наиболее точных к менее точным)
    const strategies = [
        // 1. Overpass: LLM Name + Website
        { 
            name: "Overpass (AI Name + Website)", 
            fn: () => searchHotelInRadius(aiOsmName, cityCoords.lat, cityCoords.lon, 20000, hotelWebsite) 
        },
        // 2. Overpass: Clean Sanitized Name
        { 
            name: "Overpass (Sanitized Name)", 
            fn: () => searchHotelInRadius(cleanHotelName, cityCoords.lat, cityCoords.lon, 20000) 
        },
        // 3. Nominatim: LLM Name
        { 
            name: "Nominatim (AI Name)", 
            fn: () => nominatimSearch(aiOsmName, city)
        },
        // 4. Nominatim: Clean Sanitized Name
        { 
            name: "Nominatim (Sanitized Name)", 
            fn: () => nominatimSearch(cleanHotelName, city)
        }
    ];

    for (const strategy of strategies) {
        try {
            await sleep(2000); // Обязательная пауза между стратегиями
            logger.debug(`Executing geocoding strategy: ${strategy.name}`);
            const result = await strategy.fn();
            if (result && result.lat && result.lon) {
                // Проверка: не вернул ли нам Nominatim просто координаты города? (обычно если имя совсем не подошло)
                const isCityCenter = Math.abs(parseFloat(result.lat) - cityCoords.lat) < 0.005 && 
                                   Math.abs(parseFloat(result.lon) - cityCoords.lon) < 0.005;
                
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

// Task 2: Attractions fallback to Nominatim
async function searchAttractions(lat, lon) {
    if (!lat || !lon) return [];

    logger.debug(`Searching attractions @ [${lat}, ${lon}]...`);
    
    // Method 1: Overpass
    const query = `[out:json][timeout:90];(
        node["tourism"~"museum|gallery|attraction|theme_park"](around:2000,${lat},${lon});
        way["tourism"~"museum|gallery|attraction|theme_park"](around:2000,${lat},${lon});
        node["historic"~"monument|memorial|castle"](around:2000,${lat},${lon});
    ); out tags 15;`;

    let elements = [];
    try {
        const response = await fetchWithRetry(() => axios.post('https://overpass-api.de/api/interpreter', query, {
            headers: { 'Content-Type': 'text/plain' },
            timeout: 20000
        }));
        elements = response.data.elements || [];
    } catch (err) {
        logger.warn(`Overpass attractions failed: ${err.message}. Trying Nominatim fallback...`);
        // Method 2: Nominatim Fallback
        try {
            await sleep(1500);
            const resp = await geoAxios.get('https://nominatim.openstreetmap.org/search', {
                params: { q: 'attractions', format: 'json', limit: 10, lat, lon },
                timeout: 10000
            });
            elements = (resp.data || []).map(d => ({ 
                tags: { 
                    name: d.display_name.split(',')[0], 
                    tourism: d.type === 'attraction' ? 'attraction' : 'other' 
                } 
            }));
        } catch (nomErr) {
            logger.error(`Nominatim attractions fallback failed: ${nomErr.message}`);
        }
    }

    const results = elements
        .map(el => {
            const tags = el.tags || {};
            const name = tags.name || tags['name:en'];
            if (!name) return null;

            let category = 'Attraction';
            if (tags.tourism === 'museum') category = 'Museum';
            if (tags.historic) category = 'Historic';
            return { name, category };
        })
        .filter(Boolean);

    // Unique & Slice
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
}

module.exports = { getGeoCoordinates, searchAttractions, getCityCoordinates };
