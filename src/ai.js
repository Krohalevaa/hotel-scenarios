const axios = require('axios');
const config = require('./config');
const logger = require('./logger');

async function azureChat(systemMessage, userMessage, deployment = config.AZURE_OPENAI_DEPLOYMENT) {
    const url = `${config.AZURE_OPENAI_ENDPOINT}/openai/deployments/${deployment}/chat/completions?api-version=${config.AZURE_OPENAI_API_VERSION}`;

    const response = await axios.post(url, {
        messages: [
            { role: 'system', content: systemMessage },
            { role: 'user', content: userMessage }
        ],
        temperature: 0.2,
        max_tokens: 1200
    }, {
        headers: {
            'Content-Type': 'application/json',
            'api-key': config.AZURE_OPENAI_API_KEY
        },
        timeout: 65000
    });

    return response.data?.choices?.[0]?.message?.content || '';
}

function normalizeList(items) {
    return [...new Set((Array.isArray(items) ? items : [])
        .map((item) => String(item || '').trim())
        .filter(Boolean))];
}

function buildFallbackScript(hotelData) {
    const hotelName = hotelData.hotel_name || 'this hotel';
    const location = hotelData.location || hotelData.city || 'its destination';
    const features = normalizeList([
        ...(hotelData.amenities || []),
        ...(hotelData.special_offers || []),
        ...(hotelData.nearby_attractions || [])
    ]).slice(0, 6);

    const featureText = features.length
        ? features.join(', ')
        : 'comfort, atmosphere, and memorable local experiences';

    return [
        `Welcome to ${hotelName}, where every stay begins with a sense of place in ${location}.`,
        `${hotelName} combines hospitality, character, and convenience for travelers looking for something memorable.`,
        `Guests can enjoy ${featureText}.`,
        `Whether the goal is relaxation, exploration, or a special occasion, ${hotelName} offers a setting designed to make the experience feel effortless and distinctive.`,
        `Book your stay and discover what makes ${hotelName} stand out.`
    ].join(' ');
}

async function selectRelevantPlaces(hotelData) {
    const places = Array.isArray(hotelData.discovered_attractions?.[0]?.recommended_places)
        ? hotelData.discovered_attractions[0].recommended_places
        : Array.isArray(hotelData.recommended_places)
            ? hotelData.recommended_places
            : [];

    if (!places.length) {
        return {
            selectedCategories: [],
            recommendedPlaces: []
        };
    }

    const systemMessage = `You are a travel relevance analyst.
Select the most useful nearby places for a hotel marketing video script.
Return strict JSON only with this shape:
{
  "selectedCategories": ["category"],
  "recommendedPlaces": [{ "name": "Place name", "category": "category", "reason": "short reason" }]
}
Keep only the most relevant and diverse places.`;

    const userMessage = `Hotel: ${hotelData.hotel_name}
City: ${hotelData.city}
Business goal: ${hotelData.business_goal}
Guest preference: ${hotelData.guest_preference || 'not specified'}
Places:
${JSON.stringify(places, null, 2)}`;

    try {
        const result = await azureChat(systemMessage, userMessage, config.AZURE_OPENAI_DEPLOYMENT_SQL);
        const clean = result.replace(/^```[a-z]*\n?/i, '').replace(/```$/m, '').trim();
        const parsed = JSON.parse(clean);
        return {
            selectedCategories: Array.isArray(parsed.selectedCategories) ? parsed.selectedCategories : [],
            recommendedPlaces: Array.isArray(parsed.recommendedPlaces) ? parsed.recommendedPlaces : []
        };
    } catch (err) {
        logger.error(`AI Place Selection Error: ${err.response?.data || err.message}`);
        return {
            selectedCategories: [],
            recommendedPlaces: []
        };
    }
}

async function generateScript(hotelData) {
    const systemMessage = `You are an expert hospitality video script writer.
Write in ${hotelData.language || 'English'}.
Create a concise, vivid promotional script for a hotel.
Use only the provided facts. Do not invent unavailable details.`;

    const userMessage = `Hotel data:
${JSON.stringify(hotelData, null, 2)}

Write the final video script.`;

    try {
        logger.debug(`AI: Starting Script Writer for: ${hotelData.hotel_name}`);
        const scriptText = await azureChat(systemMessage, userMessage, config.AZURE_OPENAI_DEPLOYMENT);
        return scriptText.trim();
    } catch (err) {
        logger.error(`AI Script Writer Error: ${err.response?.data || err.message}`);
        logger.error(`AI Script Writer Context: hotel=${hotelData.hotel_name}, language=${hotelData.language}, businessGoal=${hotelData.business_goal}, attractionsCount=${hotelData.nearby_attractions?.length || 0}`);
        return null;
    }
}

async function extractCleanHotelName(input, url = '') {
    if (!input && !url) return null;

    const systemMessage = `You are a data analysis expert.
Your task is to extract the clean official hotel name.
You have:
1. An input string, which may be a URL, marketing slogan, or page title.
2. The hotel website URL for context.

RULES:
- If the input string is a marketing slogan (for example, "Luxury Hotel Near Central Park"), try to find the real hotel name in the string OR extract it from the provided URL (for example, theplazany.com -> The Plaza).
- Always prioritize the real proper hotel name.
- If the name is absolutely impossible to determine, return "NULL".
- Return ONLY the hotel name, with no extra words.`;

    const userMessage = `Input string: "${input}"
Hotel website URL: "${url}"
Extract the hotel name:`;

    try {
        logger.debug(`AI: Extracting clean name for: "${input}" (URL context: ${url})`);
        const result = await azureChat(systemMessage, userMessage, config.AZURE_OPENAI_DEPLOYMENT_SQL);
        const clean = result.trim();
        logger.debug(`AI: Extracted Name: "${clean}"`);
        return clean.toUpperCase() === 'NULL' ? null : clean;
    } catch (err) {
        logger.error(`AI Name Extraction Error: ${err.response?.data || err.message}`);
        return null;
    }
}

async function predictOsmHotelData(hotelName, city, url = '') {
    const systemMessage = `You are an expert in cartography and OpenStreetMap (OSM).
Your task is to analyze a noisy hotel name, city, and URL, and predict the name under which this hotel may be listed in OpenStreetMap (the name tag).

RULES:
1. Clean the name from marketing noise such as Luxury, Near, Best, Official Site, and similar wording.
2. Consider local naming conventions. For example, hotels in OSM are often stored with the brand included, such as "The Pierre, a Taj Hotel".
3. If the name contains a domain like theplazany.com, extract the real hotel name from it, such as "The Plaza".
4. DO NOT hallucinate. If you are not confident that the hotel exists, return the cleanest possible version of the original name.
5. Also provide the expected hotel address if you can infer it from the name and city.

Return STRICT JSON only. No extra text.
Response format:
{
  "osm_target_name": "Exact name for OSM lookup and database storage",
  "expected_address": "Street, building, district"
}
6. This name will be USED as the primary hotel name in our database, so it must be as official and accurate as possible.`;

    const userMessage = `Hotel: "${hotelName}"
City: "${city}"
URL: "${url}"
Predict the OSM data:`;

    try {
        logger.debug(`AI: Predicting OSM internal name for: "${hotelName}" in ${city}`);
        const result = await azureChat(systemMessage, userMessage, config.AZURE_OPENAI_DEPLOYMENT_SQL);
        const clean = result.replace(/^```[a-z]*\n?/i, '').replace(/```$/m, '').trim();
        const parsed = JSON.parse(clean);

        logger.debug(`AI: OSM Prediction: "${parsed.osm_target_name}"`);
        return {
            osm_target_name: parsed.osm_target_name || hotelName,
            expected_address: parsed.expected_address || null
        };
    } catch (err) {
        logger.error(`AI OSM Prediction Error: ${err.message}`);
        return { osm_target_name: hotelName, expected_address: null };
    }
}

module.exports = {
    azureChat,
    buildFallbackScript,
    selectRelevantPlaces,
    generateScript,
    extractCleanHotelName,
    predictOsmHotelData
};
