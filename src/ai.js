const axios = require('axios');
const config = require('./config');
const logger = require('./logger');
const {
    buildPreferenceSummary,
    getAllCategoryKeys,
    PLACE_CATEGORY_DEFINITIONS
} = require('./placePreferences');

async function azureChat(systemMessage, userMessage, deployment) {
    const url = `https://${config.AZURE_OPENAI_API_INSTANCE_NAME}.openai.azure.com/openai/deployments/${deployment}/chat/completions?api-version=${config.AZURE_OPENAI_API_VERSION}`;

    const messages = [
        { role: 'system', content: systemMessage },
        { role: 'user', content: userMessage }
    ];

    const requestBody = {
        messages,
        max_completion_tokens: 1200,
        reasoning_effort: 'minimal'
    };

    logger.debug(`AI request prepared: deployment=${deployment}, url=${url}, apiVersion=${config.AZURE_OPENAI_API_VERSION}, hasApiKey=${Boolean(config.AZURE_OPENAI_API_KEY)}, systemLength=${systemMessage.length}, userLength=${userMessage.length}`);

    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            logger.debug(`AI request attempt ${attempt + 1} for deployment=${deployment}`);
            const response = await axios.post(
                url,
                requestBody,
                {
                    headers: {
                        'Content-Type': 'application/json',
                        'api-key': config.AZURE_OPENAI_API_KEY
                    },
                    timeout: 120000
                }
            );
            const content = response.data?.choices?.[0]?.message?.content || '';
            const finishReason = response.data?.choices?.[0]?.finish_reason || 'unknown';
            logger.debug(`AI request succeeded on attempt ${attempt + 1} for deployment=${deployment}; finishReason=${finishReason}; contentLength=${content.length}`);
            return content;
        } catch (error) {
            lastError = error;
            const responseStatus = error.response?.status || 'unknown';
            const responseData = typeof error.response?.data === 'string'
                ? error.response.data
                : JSON.stringify(error.response?.data || {});
            logger.warn(`AI attempt ${attempt + 1} failed: ${error.message}; status=${responseStatus}; response=${responseData}`);
            if (attempt < 2) {
                await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)));
            }
        }
    }

    throw new Error(`AI Request failed after 3 attempts: ${lastError.message}`);
}

function formatPlaceForPrompt(place) {
    const categories = Array.isArray(place?.categories) && place.categories.length
        ? place.categories.join(', ')
        : place?.category || 'unknown';

    return `${place?.name || 'Unknown place'} [categories: ${categories}]${place?.address ? `, address: ${place.address}` : ''}`;
}

function normalizeDiscoveredAttractions(discoveredAttractions) {
    if (!Array.isArray(discoveredAttractions) || discoveredAttractions.length === 0) {
        return [];
    }

    const latestRecord = discoveredAttractions[0] || {};
    const attractionCategories = latestRecord.attraction_categories;
    if (!attractionCategories || typeof attractionCategories !== 'object' || Array.isArray(attractionCategories)) {
        return [];
    }

    return Object.entries(attractionCategories).map(([name, category]) => ({
        name,
        category: String(category || 'unknown'),
        categories: [String(category || 'unknown')]
    }));
}

function buildFallbackScript(hotelData) {
    const hotelName = hotelData.hotel_name || 'the hotel';
    const city = hotelData.city || 'the city';
    const country = hotelData.country || 'the destination';
    const attractions = Array.isArray(hotelData.recommended_places) && hotelData.recommended_places.length
        ? hotelData.recommended_places.slice(0, 5)
        : Array.isArray(hotelData.nearby_attractions)
            ? hotelData.nearby_attractions.slice(0, 5)
            : [];
    const attractionText = attractions.length
        ? attractions.map((item) => item.name || item.attraction_name || item).filter(Boolean).join(', ')
        : 'popular local attractions';

    return [
        `Welcome to ${hotelName}, a comfortable stay in ${city}, ${country}.`,
        `${hotelName} offers travelers a convenient base for exploring ${city} and enjoying a smooth, relaxing trip.`,
        `Nearby points of interest include ${attractionText}, giving guests easy access to memorable experiences during their visit.`,
        `Whether you are traveling for leisure or business, ${hotelName} is positioned to help you enjoy the best of ${city}.`,
        `Book your stay at ${hotelName} and discover everything this destination has to offer.`
    ].join(' ');
}

async function selectRelevantPlaces(hotelData) {
    const allPlaces = normalizeDiscoveredAttractions(hotelData.discovered_attractions);
    if (allPlaces.length === 0) {
        return {
            selectedCategories: [],
            recommendedPlaces: [],
            rejectedPlaces: []
        };
    }

    const preferenceSummary = buildPreferenceSummary(hotelData.guest_preference);
    const fallbackCategories = preferenceSummary.map((item) => item.key);
    const categoryDefinitions = getAllCategoryKeys().map((key) => ({
        key,
        label: PLACE_CATEGORY_DEFINITIONS[key]?.label || key
    }));

    const systemMessage = `You are an AI travel relevance agent.
Your task is to select only the nearby public places that match the guest preference.

RULES:
1. Return STRICT JSON only.
2. Use only categories from the allowed list.
3. If guest preference is sports, keep sports-related places only.
4. If guest preference is shopping, keep shopping-related places only.
5. If guest preference is children/family, keep family and kids places only.
6. If guest preference is honeymoon/romance, keep romantic, scenic, park, viewpoint, fine dining, and couple-friendly places only.
7. Reject places that do not match the preference.
8. Keep up to 12 best matching places.
9. Prefer places with direct category match over generic attractions.
10. If preference is empty or unclear, use the fallback categories inferred from the preference parser. If still empty, keep the best diverse places.

JSON FORMAT:
{
  "selected_categories": ["sports"],
  "recommended_place_names": ["Madison Square Garden"],
  "rejected_place_names": ["Broadway Theatre"],
  "reason": "short explanation"
}`;

    const userMessage = `Guest preference: ${hotelData.guest_preference || 'Not specified'}
Fallback inferred categories: ${fallbackCategories.join(', ') || 'none'}
Allowed categories: ${JSON.stringify(categoryDefinitions)}
Nearby public places:
${allPlaces.map((place) => `- ${formatPlaceForPrompt(place)}`).join('\n')}`;

    try {
        const raw = await azureChat(systemMessage, userMessage, config.AZURE_OPENAI_DEPLOYMENT_SQL);
        const clean = raw.replace(/^```[a-z]*\n?/i, '').replace(/```$/m, '').trim();
        const parsed = JSON.parse(clean);

        const selectedCategories = Array.isArray(parsed.selected_categories)
            ? parsed.selected_categories.filter((item) => getAllCategoryKeys().includes(item))
            : fallbackCategories;
        const recommendedNames = new Set(Array.isArray(parsed.recommended_place_names) ? parsed.recommended_place_names : []);
        const rejectedNames = new Set(Array.isArray(parsed.rejected_place_names) ? parsed.rejected_place_names : []);

        let recommendedPlaces = allPlaces.filter((place) => recommendedNames.has(place.name));
        if (recommendedPlaces.length === 0 && selectedCategories.length > 0) {
            recommendedPlaces = allPlaces.filter((place) => (place.categories || []).some((category) => selectedCategories.includes(category)));
        }
        if (recommendedPlaces.length === 0) {
            recommendedPlaces = allPlaces.slice(0, 12);
        }

        const rejectedPlaces = allPlaces.filter((place) => rejectedNames.has(place.name));

        return {
            selectedCategories,
            recommendedPlaces: recommendedPlaces.slice(0, 12),
            rejectedPlaces,
            reason: parsed.reason || null
        };
    } catch (err) {
        logger.warn(`AI place selection failed, using parser fallback: ${err.message}`);
        const selectedCategories = fallbackCategories;
        const recommendedPlaces = selectedCategories.length > 0
            ? allPlaces.filter((place) => (place.categories || []).some((category) => selectedCategories.includes(category))).slice(0, 12)
            : allPlaces.slice(0, 12);

        return {
            selectedCategories,
            recommendedPlaces,
            rejectedPlaces: [],
            reason: 'fallback parser selection'
        };
    }
}

async function generateScript(hotelData) {
    const formattedAmenities = Array.isArray(hotelData.amenities)
        ? hotelData.amenities.join(', ')
        : hotelData.amenities || 'Not specified';
    const formattedOffers = Array.isArray(hotelData.special_offers)
        ? hotelData.special_offers.join(', ')
        : hotelData.special_offers || 'Not specified';
    const formattedPhotos = Array.isArray(hotelData.photos)
        ? hotelData.photos.join(', ')
        : hotelData.photos || 'Not specified';
    const formattedAttractions = Array.isArray(hotelData.nearby_attractions)
        ? hotelData.nearby_attractions.map((item) => {
            if (typeof item === 'string') return item;
            if (item && typeof item === 'object') return item.name || item.title || JSON.stringify(item);
            return String(item);
        }).join(', ')
        : hotelData.nearby_attractions || 'Not specified';
    const formattedRecommendedPlaces = Array.isArray(hotelData.recommended_places)
        ? hotelData.recommended_places.map((item) => formatPlaceForPrompt(item)).join(', ')
        : 'Not specified';
    const formattedSelectedCategories = Array.isArray(hotelData.selected_place_categories)
        ? hotelData.selected_place_categories.join(', ')
        : 'Not specified';

    const systemMessage = `You are a professional scriptwriter for short, dynamic TikTok/Reels hotel commercials optimized for AI video generation tools.

Your task is to create a high-quality short-form video script that can be used to generate a polished promotional hotel video. The script must use as much of the provided hotel data as possible and must strongly support the Business Goal.

CRITICAL OUTPUT RULES:
1. Write the entire script only in the language specified in "Target Language".
2. Do not use English unless the Target Language is English.
3. Output between 4 and 7 scenes.
4. Each scene must be fully specified and production-ready.
5. The script must feel premium, specific, visual, and commercially persuasive.
6. Do not invent facts that are not supported by the provided hotel data.
7. If some data is missing, simply emphasize the strongest available details.
8. If guest preference exists, prioritize only preference-matching nearby places in the script.
9. Mention only places from Recommended Nearby Places when that list is available.

STRICT OUTPUT FORMAT:
15s TikTok/Reels Script – [Hotel Name], [City or Location]

For HeyGen – avatar ALWAYS in bottom-left corner, small, overlaid on footage.
Avatar: points toward center of screen when presenting something, then relaxes hands / nods to confirm.

Total scenes: [4-7]
Primary business goal: [Business Goal]

⸻

Scene 1 – [SHORT TITLE] ([TIMECODE])
• Goal of scene: [What this scene must achieve in persuasion terms]
• Visual: [Exact footage direction, camera movement, what to show]
• Avatar: [Pose and action]
• On-screen text (position): [Exact text]
• Voiceover:
"[Natural creator-style line]"

[Repeat the same block for every next scene]

FINAL SCENE RULE:
For the last scene, use this exact field name instead of the regular on-screen text line:
• On-screen Text (center, bold):
[Exact CTA text]

CONTENT REQUIREMENTS:
1. Business Goal is the main strategic driver of the whole script. The hook, middle scenes, and final CTA must all support it directly.
2. Scene 1 must immediately create desire, urgency, curiosity, or relevance based on the Business Goal.
3. Use 4 to 7 scenes depending on how much useful hotel information is available. Do not force extra scenes if the data is thin.
4. Every scene must introduce a distinct angle, for example: hook, room experience, amenities, location, atmosphere, offer, CTA.
5. Mention specific amenities and differentiators whenever available.
6. You MUST mention at least 1–2 specific nearby attractions from the Recommended Nearby Places list if any are provided.
7. If special offers are provided, integrate them naturally into the final scene or the scene before the final CTA. If no offer exists, create urgency aligned with the Business Goal without inventing fake discounts.
8. Visual directions must be concrete and useful for AI video generation: mention shot type, movement, subject, and mood.
9. On-screen text must be short, readable, and impactful.
10. Voiceover must sound natural for TikTok/Reels: energetic, warm, slightly intimate, not corporate.
11. Maximize use of the provided hotel information: hotel name, location, description, amenities, special offers, photos, recommended nearby places, and business goal.
12. Keep the whole script concise enough for an approximately 15-second video.
13. If photos are provided, use them as visual inspiration for what to show in the scenes.
14. Do not output explanations, notes, JSON, or commentary outside the script.`;

    const userMessage = `CRITICAL: You MUST write the entire script (all scene titles, scene goals, visuals, avatar actions, on-screen text, and voiceover) in the language specified in the "Target Language" field.

Now create a scenario for the hotel based on the provided data:

Hotel Name: ${hotelData.hotel_name}
Location: ${hotelData.location}
Description: ${hotelData.description}
Special Offers: ${formattedOffers}
Amenities: ${formattedAmenities}
Photos: ${formattedPhotos}
Nearby Attractions: ${formattedAttractions}
Recommended Nearby Places: ${formattedRecommendedPlaces}
Selected Place Categories: ${formattedSelectedCategories}
Business Goal: ${hotelData.business_goal}
Guest Preference: ${hotelData.guest_preference || 'Not specified'}
Target Language: ${hotelData.language}`;

    try {
        logger.debug(`AI: Starting Script Writer for: ${hotelData.hotel_name}`);
        const scriptText = await azureChat(systemMessage, userMessage, config.AZURE_OPENAI_DEPLOYMENT_SCRIPT);
        logger.debug(`AI: Script Writer finished. hasText=${Boolean(scriptText)} length=${scriptText?.length || 0}`);
        return scriptText.trim();
    } catch (err) {
        logger.error(`AI Script Writer Error: ${err.response?.data || err.message}`);
        logger.error(`AI Script Writer Context: hotel=${hotelData.hotel_name}, language=${hotelData.language}, businessGoal=${hotelData.business_goal}, attractionsCount=${hotelData.nearby_attractions?.length || 0}`);
        return null;
    }
}

async function extractCleanHotelName(input, url = '') {
    if (!input && !url) return null;

    const systemMessage = `Ты — эксперт по анализу данных.
Твоя задача — извлечь чистое официальное название отеля.
У тебя есть:
1. Входная строка (может быть URL, рекламный слоган или заголовок страницы).
2. URL сайта отеля (для контекста).

ПРАВИЛА:
- Если входная строка — это рекламный слоган ("Luxury Hotel Near Central Park"), попытайся найти реальное название в этой строке ИЛИ извлеки его из предоставленного URL (например, theplazany.com -> The Plaza).
- Всегда отдавай приоритет реальному имени собственному.
- Если название абсолютно невозможно найти, верни "NULL".
- Возвращай ТОЛЬКО название отеля, без лишних слов.`;

    const userMessage = `Входная строка: "${input}"
URL сайта: "${url}"
Извлеки название отеля:`;

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
    const systemMessage = `Ты — эксперт по картографии и OpenStreetMap (OSM).
Твоя задача — проанализировать "грязное" название отеля, город и URL, и предсказать, под каким именно именем этот отель МОЖЕТ быть записан в базе OpenStreetMap (тег name).

ПРАВИЛА:
1. Очисти название от маркетингового мусора (Luxury, Near, Best, Official Site и т.д.).
2. Учитывай локальные особенности (например, в OSM отели часто записаны с брендом: "The Pierre, a Taj Hotel").
3. Если название содержит домен (theplazany.com), выдели из него реальное имя ("The Plaza").
4. СТРОГО ЗАПРЕЩЕНО галлюцинировать. Если ты не уверен в существовании отеля, верни максимально очищенную версию оригинального названия.
5. Выдай также ожидаемый адрес отеля, если можешь его определить по названию и городу.

Верни СТРОГО JSON формат. Никакого лишнего текста.
Формат ответа:
{
  "osm_target_name": "Точное Название для поиска в OSM и записи в БД",
  "expected_address": "Улица, Дом, Район"
}
6. Это название будет ИСПОЛЬЗОВАНО как основное название отеля в нашей базе данных, поэтому оно должно быть максимально официальным и точным.`;

    const userMessage = `Отель: "${hotelName}"
Город: "${city}"
URL: "${url}"
Предскажи данные для OSM:`;

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
    generateScript,
    selectRelevantPlaces,
    extractCleanHotelName,
    predictOsmHotelData,
    buildFallbackScript
};
