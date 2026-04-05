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

function formatList(items, fallback = 'not specified') {
    const normalized = normalizeList(items);
    return normalized.length ? normalized.join(', ') : fallback;
}

function buildStructuredFallbackScript(hotelData) {
    const hotelName = hotelData.hotel_name || 'this hotel';
    const language = hotelData.language || 'English';
    const location = hotelData.location || hotelData.address || hotelData.city || 'its destination';
    const businessGoal = hotelData.business_goal || 'increase direct bookings';
    const guestPreference = hotelData.guest_preference || 'not specified';
    const amenities = normalizeList(hotelData.amenities).slice(0, 6);
    const offers = normalizeList(hotelData.special_offers).slice(0, 4);
    const attractions = normalizeList(
        (hotelData.recommended_places || []).map((item) => item.name || item.attraction_name)
            .concat(hotelData.nearby_attractions || [])
    ).slice(0, 8);

    const priceSegments = [
        {
            title: 'Scene 1 — Entry / Value segment',
            audience: 'price-conscious travelers',
            focus: 'accessible comfort and smart value'
        },
        {
            title: 'Scene 2 — Mid-tier stay',
            audience: 'couples and regular city visitors',
            focus: 'balanced comfort, convenience, and local access'
        },
        {
            title: 'Scene 3 — Premium experience',
            audience: 'guests seeking elevated stays',
            focus: 'signature features, atmosphere, and memorable service'
        },
        {
            title: 'Scene 4 — Business-fit segment',
            audience: 'business and goal-oriented travelers',
            focus: `supporting the business goal: ${businessGoal}`
        }
    ];

    if (offers.length) {
        priceSegments.push({
            title: 'Scene 5 — Offer-driven conversion',
            audience: 'guests comparing options before booking',
            focus: `special offers and booking motivation: ${offers.join(', ')}`
        });
    }

    if (attractions.length) {
        priceSegments.push({
            title: 'Scene 6 — Destination pull',
            audience: 'travelers choosing the area experience',
            focus: `nearby attractions and local highlights: ${attractions.join(', ')}`
        });
    }

    const intro = language.toLowerCase().startsWith('ru')
        ? `Отель ${hotelName} в ${location} может быть представлен как серия из 4–6 сцен, где каждая сцена ведет гостя к бронированию.`
        : `${hotelName} in ${location} can be presented as a 4–6 scene sequence where each scene moves the guest closer to booking.`;

    const scenes = priceSegments.slice(0, 6).map((scene, index) => {
        const attractionText = attractions.length
            ? `Use these attractions where relevant: ${attractions.join(', ')}.`
            : 'No confirmed attractions were found, so focus on hotel-led experience.';
        const amenityText = amenities.length
            ? `Hotel facts to weave in: ${amenities.join(', ')}.`
            : 'Use available hotel facts without inventing extra amenities.';

        return `${scene.title}\nAudience: ${scene.audience}.\nFocus: ${scene.focus}.\nGuest preference to reflect: ${guestPreference}.\n${amenityText}\n${attractionText}`;
    });

    return [intro, ...scenes].join('\n\n');
}

async function generateScript(hotelData) {
    const hotelFacts = {
        hotel_name: hotelData.hotel_name || null,
        city: hotelData.city || null,
        country: hotelData.country || null,
        address: hotelData.address || null,
        location: hotelData.location || null,
        business_goal: hotelData.business_goal || null,
        guest_preference: hotelData.guest_preference || null,
        language: hotelData.language || 'English',
        amenities: normalizeList(hotelData.amenities).slice(0, 12),
        special_offers: normalizeList(hotelData.special_offers).slice(0, 8),
        selected_place_categories: normalizeList(hotelData.selected_place_categories).slice(0, 8),
        recommended_places: (Array.isArray(hotelData.recommended_places) ? hotelData.recommended_places : []).slice(0, 12),
        nearby_attractions: normalizeList(hotelData.nearby_attractions).slice(0, 12),
        description: hotelData.description || null
    };

    const systemMessage = `You are an expert hospitality video script writer.
Write in ${hotelData.language || 'English'}.
Return only the final script text.
Create a detailed hotel promo script with 4 to 6 scenes.
The script must be structured by price/value segments, moving from more accessible value to more premium positioning.
Every scene must explicitly support the hotel's business goal, reflect the user's wishes/preferences, and use all relevant discovered attractions and hotel facts that were provided.
Do not make the script short or generic.
Do not invent facts that are not present in the input.
If some facts are missing, work only with the available data.
Use a clear scene-by-scene format:
Scene 1: ...
Scene 2: ...
Each scene should contain a visual direction and voice-over text.
Make the progression persuasive and commercially useful.`;

    const userMessage = `Create the final hotel video script using these requirements:
1. Produce 4 to 6 scenes.
2. Split the narrative by price/value positioning, not as one short paragraph.
3. In every scene, account for the business goal.
4. In every scene, reflect the guest preference if provided.
5. Use the discovered attractions throughout the script, not just once.
6. Use the hotel information, amenities, offers, address/location, and other provided facts.
7. Keep the script detailed enough for production.
8. Return only the final script.

Hotel data:
${JSON.stringify(hotelFacts, null, 2)}

Important attraction coverage:
- Recommended places: ${formatList((hotelData.recommended_places || []).map((item) => item.name || item.attraction_name), 'none')}
- Nearby attractions: ${formatList(hotelData.nearby_attractions, 'none')}
- Selected categories: ${formatList(hotelData.selected_place_categories, 'none')}

Write the final script now.`;

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
    buildStructuredFallbackScript,
    selectRelevantPlaces,
    generateScript,
    extractCleanHotelName,
    predictOsmHotelData
};
