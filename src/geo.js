const axios = require('axios');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const {
    DEFAULT_RADIUS_METERS,
    PLACE_CATEGORY_DEFINITIONS,
    getAllCategoryKeys,
    normalizeText
} = require('./placePreferences');

const geoAxios = axios.create({
    headers: {
        'User-Agent': 'HotelScenarioGenerator/2.0 (akrohaleva67@gmail.com)'
    }
});

const CITY_CACHE_FILE = path.join(__dirname, '../city_cache.json');
let cityCache = new Map([
    ['New York', { lat: 40.7128, lon: -74.0060 }],
    ['London', { lat: 51.5074, lon: -0.1278 }],
    ['Paris', { lat: 48.8566, lon: 2.3522 }],
    ['Las Vegas', { lat: 36.1716, lon: -115.1391 }],
    ['Los Angeles', { lat: 34.0522, lon: -118.2437 }],
    ['Chicago', { lat: 41.8781, lon: -87.6298 }],
    ['Washington DC', { lat: 38.9072, lon: -77.0369 }],
    ['Miami Beach', { lat: 25.7907, lon: -80.1300 }]
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchWithRetry(requestFn, maxRetries = 3) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await requestFn();
        } catch (err) {
            const status = err.response?.status;
            const shouldRetry = status === 429 || (status >= 500 && status <= 504);

            if (shouldRetry && attempt < maxRetries) {
                const delay = (status === 429 ? 15000 : 3000) * Math.pow(2, attempt);
                logger.warn(`Retry attempt ${attempt + 1} after ${delay}ms due to status ${status}`);
                await new Promise((resolve) => setTimeout(resolve, delay));
                continue;
            }
            throw err;
        }
    }
}

function sanitizeHotelName(name) {
    if (!name) return '';

    logger.debug(`Sanitizing hotel name: "${name}"`);
    let clean = name.replace(/^(https?:\/\/)?(www\.)?/i, '');
    clean = clean.split('/')[0].replace(/\.(com|net|org|biz|info|gov|edu|me|tv|io|ru|us|uk|ca|site)(\..+)?$/i, '');

    const stopPhrases = [
        'Official Site', 'Official Website', 'Best Rate Guaranteed',
        'Exclusive Stay', 'Welcome to', 'LLC', 'Premium', 'Classic'
    ];

    const regexStopWords = new RegExp(`\\b(${stopPhrases.join('|')})\\b`, 'gi');

    clean = clean
        .replace(regexStopWords, '')
        .replace(/[._\-+,]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    logger.debug(`Sanitized result: "${clean}"`);
    return clean;
}

async function getCityCoordinates(city) {
    if (!city) return null;

    if (cityCache.has(city)) {
        logger.debug(`City "${city}" found in cache.`);
        return cityCache.get(city);
    }

    logger.info(`Geocoding City: "${city}"...`);
    try {
        await sleep(1500);
        const response = await fetchWithRetry(() => geoAxios.get('https://nominatim.openstreetmap.org/search', {
            params: { city, format: 'json', limit: 1 },
            timeout: 7000
        }));
        if (response.data[0]) {
            const coords = { lat: response.data[0].lat, lon: response.data[0].lon };
            logger.info(`City "${city}" found at [${coords.lat}, ${coords.lon}]`);
            cityCache.set(city, coords);
            saveCityCache();
            return coords;
        }
        logger.warn(`City "${city}" NOT found.`);
        return null;
    } catch (err) {
        logger.error(`City search error for ${city}: ${err.message}`);
        return null;
    }
}


async function searchHotelInRadius(name, cityLat, cityLon, radius = 20000, website = '') {
    if ((!name || name.length < 3) && !website) {
        logger.warn(`Search parameters too weak: name="${name}", website="${website}"`);
        return null;
    }

    logger.info(`Searching hotel "${name}" ${website ? `(site: ${website})` : ''} via Overpass in ${radius}m radius...`);

    const cleanName = (name || '').replace(/['"\\/]/g, '');
    const domainPart = website ? website.replace(/https?:\/\//, '').replace(/^www\./, '').split('/')[0] : '';

    const exactQuery = `[out:json][timeout:30];(
        node["tourism"~"hotel|resort|guest_house|hostel"]["name"="${cleanName}"](around:${radius},${cityLat},${cityLon});
        way["tourism"~"hotel|resort|guest_house|hostel"]["name"="${cleanName}"](around:${radius},${cityLat},${cityLon});
    ); out center 1;`;

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
                    lat,
                    lon,
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

async function nominatimSearch(query, city) {
    try {
        await sleep(1500);
        const resp = await fetchWithRetry(() => geoAxios.get('https://nominatim.openstreetmap.org/search', {
            params: { q: `${query}, ${city}`, format: 'json', limit: 5 },
            timeout: 8000
        }));

        if (!resp.data || resp.data.length === 0) return null;

        const matched = resp.data.find((item) =>
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

    const cityCoords = await getCityCoordinates(city);
    if (!cityCoords) {
        logger.error(`Geocoding aborted for "${hotelName}": city coords missing.`);
        return { geo_lat: null, geo_lon: null, address: null, country: null, _geo_debug_name: null };
    }

    const strategies = [
        {
            name: 'Overpass (AI Name + Website)',
            fn: () => searchHotelInRadius(aiOsmName, cityCoords.lat, cityCoords.lon, 20000, hotelWebsite)
        },
        {
            name: 'Overpass (Sanitized Name)',
            fn: () => searchHotelInRadius(cleanHotelName, cityCoords.lat, cityCoords.lon, 20000)
        },
        {
            name: 'Nominatim (AI Name)',
            fn: () => nominatimSearch(aiOsmName, city)
        },
        {
            name: 'Nominatim (Sanitized Name)',
            fn: () => nominatimSearch(cleanHotelName, city)
        }
    ];

    for (const strategy of strategies) {
        try {
            await sleep(2000);
            logger.debug(`Executing geocoding strategy: ${strategy.name}`);
            const result = await strategy.fn();
            if (result && result.lat && result.lon) {
                const isCityCenter = Math.abs(parseFloat(result.lat) - cityCoords.lat) < 0.005 &&
                    Math.abs(parseFloat(result.lon) - cityCoords.lon) < 0.005;

                if (!isCityCenter) {
                    logger.info(`Strategy "${strategy.name}" SUCCESS: [${result.lat}, ${result.lon}]`);
                    return {
                        geo_lat: parseFloat(result.lat),
                        geo_lon: parseFloat(result.lon),
                        address: result.address || result.name,
                        country: null,
                        _geo_debug_name: `${result.name || hotelName} (${strategy.name})`
                    };
                }
                logger.debug(`Strategy "${strategy.name}" returned city center, skipping...`);
            }
        } catch (err) {
            logger.error(`Strategy "${strategy.name}" failed: ${err.message}`);
        }
    }

    logger.warn(`All geocoding strategies failed for "${hotelName}". Using City Center fallback.`);
    return {
        geo_lat: parseFloat(cityCoords.lat),
        geo_lon: parseFloat(cityCoords.lon),
        address: city,
        country: null,
        _geo_debug_name: `${city} Center (Final Fallback)`
    };
}

function escapeOverpassValue(value) {
    return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function buildTagQuery(elementType, tagKey, tagValue, radius, lat, lon) {
    const escapedKey = escapeOverpassValue(tagKey);
    if (tagValue === '*') {
        return `${elementType}["${escapedKey}"](around:${radius},${lat},${lon});`;
    }

    const escapedValue = escapeOverpassValue(tagValue);
    return `${elementType}["${escapedKey}"="${escapedValue}"](around:${radius},${lat},${lon});`;
}

function buildPublicPlacesQuery(radius, lat, lon, categories = getAllCategoryKeys()) {
    const queryParts = [];
    const categoryKeys = Array.isArray(categories) && categories.length
        ? categories.filter((category) => PLACE_CATEGORY_DEFINITIONS[category])
        : getAllCategoryKeys();

    for (const categoryKey of categoryKeys) {
        const definition = PLACE_CATEGORY_DEFINITIONS[categoryKey];
        for (const [tagKey, tagValues] of Object.entries(definition.osm || {})) {
            for (const tagValue of tagValues) {
                queryParts.push(buildTagQuery('node', tagKey, tagValue, radius, lat, lon));
                queryParts.push(buildTagQuery('way', tagKey, tagValue, radius, lat, lon));
                queryParts.push(buildTagQuery('relation', tagKey, tagValue, radius, lat, lon));
            }
        }
    }

    return `[out:json][timeout:25];(${queryParts.join('\n')});out center tags qt;`;
}

function inferCategoriesFromTags(tags = {}) {
    const categories = new Set();
    const normalizedTags = Object.entries(tags).map(([key, value]) => `${normalizeText(key)} ${normalizeText(value)}`.trim());

    for (const [categoryKey, definition] of Object.entries(PLACE_CATEGORY_DEFINITIONS)) {
        const osmRules = definition.osm || {};
        const keywordRules = definition.keywords || [];

        for (const [tagKey, tagValues] of Object.entries(osmRules)) {
            const tagValue = tags[tagKey];
            if (!tagValue) continue;
            if (tagValues.includes('*') || tagValues.includes(tagValue)) {
                categories.add(categoryKey);
            }
        }

        if (keywordRules.some((keyword) => normalizedTags.some((tagText) => tagText.includes(keyword)))) {
            categories.add(categoryKey);
        }
    }

    return [...categories];
}

function buildPlaceRecord(element, radius) {
    const tags = element.tags || {};
    const name = tags.name || tags['name:en'];
    if (!name) {
        return null;
    }

    const lat = element.lat || element.center?.lat || null;
    const lon = element.lon || element.center?.lon || null;
    const categories = inferCategoriesFromTags(tags);
    if (categories.length === 0) {
        return null;
    }

    return {
        name,
        category: categories[0],
        categories,
        source: 'overpass',
        radius_meters: radius,
        latitude: lat ? Number(lat) : null,
        longitude: lon ? Number(lon) : null,
        osm_type: element.type || null,
        osm_id: element.id || null,
        tags,
        address: tags['addr:full'] || [tags['addr:street'], tags['addr:housenumber']].filter(Boolean).join(' ').trim() || null
    };
}

function dedupePlaces(places) {
    const seen = new Map();

    for (const place of places) {
        const key = normalizeText(place.name);
        if (!key) continue;

        const existing = seen.get(key);
        if (!existing) {
            seen.set(key, place);
            continue;
        }

        const mergedCategories = [...new Set([...(existing.categories || []), ...(place.categories || [])])];
        seen.set(key, {
            ...existing,
            ...place,
            category: existing.category || place.category,
            categories: mergedCategories
        });
    }

    return [...seen.values()];
}

function filterPlacesByPreference(places, preferredCategories = []) {
    if (!Array.isArray(places) || places.length === 0) {
        return [];
    }

    if (!Array.isArray(preferredCategories) || preferredCategories.length === 0) {
        return places;
    }

    const preferred = new Set(preferredCategories);
    return places.filter((place) => (place.categories || []).some((category) => preferred.has(category)));
}

async function searchPublicPlaces(lat, lon, options = {}) {
    if (!lat || !lon) return [];

    const radius = Number(options.radius || DEFAULT_RADIUS_METERS);
    const categories = Array.isArray(options.categories) && options.categories.length
        ? options.categories.filter((category) => PLACE_CATEGORY_DEFINITIONS[category])
        : getAllCategoryKeys();
    const chunkSize = Number(options.chunkSize || 3);

    logger.info(`Searching public places @ [${lat}, ${lon}] within ${radius}m for categories: ${categories.join(', ')}...`);

    const categoryChunks = [];
    for (let index = 0; index < categories.length; index += chunkSize) {
        categoryChunks.push(categories.slice(index, index + chunkSize));
    }

    const collectedPlaces = [];

    for (const categoryChunk of categoryChunks) {
        const query = buildPublicPlacesQuery(radius, lat, lon, categoryChunk);

        try {
            const response = await fetchWithRetry(() => axios.post('https://overpass-api.de/api/interpreter', query, {
                headers: { 'Content-Type': 'text/plain' },
                timeout: 30000
            }));

            const elements = response.data.elements || [];
            const places = elements
                .map((element) => buildPlaceRecord(element, radius))
                .filter(Boolean);

            logger.info(`Found ${places.length} public places for categories: ${categoryChunk.join(', ')}.`);
            collectedPlaces.push(...places);
        } catch (err) {
            logger.error(`Public places search failed for categories ${categoryChunk.join(', ')}: ${err.message}`);

            if (categoryChunk.length > 1) {
                logger.warn(`Retrying public places search category-by-category for: ${categoryChunk.join(', ')}`);
                for (const category of categoryChunk) {
                    const fallbackPlaces = await searchPublicPlaces(lat, lon, {
                        ...options,
                        categories: [category],
                        chunkSize: 1
                    });
                    collectedPlaces.push(...fallbackPlaces);
                }
                continue;
            }

            if (radius > 1500) {
                const fallbackRadius = Math.max(1500, Math.round(radius / 2));
                logger.warn(`Retrying public places search for ${categoryChunk[0]} with reduced radius: ${fallbackRadius}m`);
                const fallbackPlaces = await searchPublicPlaces(lat, lon, {
                    ...options,
                    radius: fallbackRadius,
                    categories: categoryChunk,
                    chunkSize: 1
                });
                collectedPlaces.push(...fallbackPlaces);
            }
        }
    }

    const dedupedPlaces = dedupePlaces(collectedPlaces);
    logger.info(`Found ${dedupedPlaces.length} public places in radius ${radius}m after merge.`);
    return dedupedPlaces;
}

async function searchAttractions(lat, lon) {
    const places = await searchPublicPlaces(lat, lon, {
        radius: DEFAULT_RADIUS_METERS,
        categories: getAllCategoryKeys()
    });

    return places.slice(0, 60);
}

module.exports = {
    getGeoCoordinates,
    searchAttractions,
    searchPublicPlaces,
    filterPlacesByPreference,
    getCityCoordinates
};
