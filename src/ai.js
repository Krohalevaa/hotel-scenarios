const axios = require('axios');
const config = require('./config');
const logger = require('./logger');

/**
 * Direct Azure OpenAI REST API call (no LangChain needed).
 */
async function azureChat(systemMessage, userMessage, deployment) {
    const url = `https://${config.AZURE_OPENAI_API_INSTANCE_NAME}.openai.azure.com/openai/deployments/${deployment}/chat/completions?api-version=${config.AZURE_OPENAI_API_VERSION}`;

    const messages = [
        { role: 'system', content: systemMessage },
        { role: 'user', content: userMessage }
    ];

    const requestBody = {
        messages,
        max_completion_tokens: 800,
        temperature: 0.7
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
            logger.debug(`AI request succeeded on attempt ${attempt + 1} for deployment=${deployment}`);
            return response.data.choices[0].message.content;
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

function buildFallbackScript(hotelData) {
    const hotelName = hotelData.hotel_name || 'the hotel';
    const city = hotelData.city || 'the city';
    const country = hotelData.country || 'the destination';
    const attractions = Array.isArray(hotelData.nearby_attractions) ? hotelData.nearby_attractions.slice(0, 5) : [];
    const attractionText = attractions.length
        ? attractions.map((item) => item.name).filter(Boolean).join(', ')
        : 'popular local attractions';

    return [
        `Welcome to ${hotelName}, a comfortable stay in ${city}, ${country}.`,
        `${hotelName} offers travelers a convenient base for exploring ${city} and enjoying a smooth, relaxing trip.`,
        `Nearby points of interest include ${attractionText}, giving guests easy access to memorable experiences during their visit.`,
        `Whether you are traveling for leisure or business, ${hotelName} is positioned to help you enjoy the best of ${city}.`,
        `Book your stay at ${hotelName} and discover everything this destination has to offer.`
    ].join(' ');
}

async function generateScript(hotelData) {
    const systemMessage = `You are a professional scriptwriter for short, dynamic TikTok/Reels commercials. You specialize in scripts for the hotel industry.

Task: Using the hotel data provided, create a script for a 15-second video in the exact format shown in the example provided. The script should be concise, punchy, and have a clear call to action that heavily pushes the specified Business Goal.

Original format (strictly adhere to this structure and markup):

15s TikTok Script – [Hotel Name], [City]

For HeyGen – avatar ALWAYS in bottom-left corner, small, overlaid on footage.
Avatar: points toward center of screen when "showing" something, then drops hands / nods to confirm.

⸻

Scene 1 – HOOK (0–4s)
• Visual: [Description]
• Avatar: [Pose and Action]
• On-screen text (position): [Text]
• Voiceover:
"[Phrase]"

⸻

Scene 2 – [SCENE TITLE] (4–8s)
• Visual: [Description]
• Avatar: [Pose and Action]
• On-screen text (position): [Text]
• Voiceover:
"[Phrase]"

⸻

Scene 3 – LOCATION & PERKS (8–12s)
• Visual: [Description]
• Avatar: [Pose and Action]
• On-screen text (position): [Text]
• Voiceover:
"[Phrase]"

⸻

Scene 4 – DEAL & CTA (12–15s)
• Visual: [Description]
• Avatar: [Pose and Action]
• On-screen Text (center, bold):
[Sentence Text]
• Voiceover:
"[Phrase]"

Instructions for Generating Content:
1. Business Goal Focus: The primary objective of this video is the "Business Goal". Scene 1 (Hook) and Scene 4 (CTA) MUST be tailored to achieve this goal.
2. Scene 3 (Location): MUST mention at least one or two specific places from the "Nearby Attractions" list.
3. Special Offers: Integrate into Scene 4. If none exist, create a generic urgent offer based on Business Goal.
4. Visuals: Use "slow zoom in", "quick cut to", etc.
5. Tone: Energetic, friendly, slightly intimate.`;

    const userMessage = `CRITICAL: Write the entire script in the language specified in "Target Language". Do not use English unless Target Language is English.

Hotel Name: ${hotelData.hotel_name}
Location: ${hotelData.location}
Description: ${hotelData.description}
Special Offers: ${JSON.stringify(hotelData.special_offers)}
Amenities: ${JSON.stringify(hotelData.amenities)}
Nearby Attractions: ${hotelData.nearby_attractions ? hotelData.nearby_attractions.join(', ') : 'Not specified'}
Business Goal: ${hotelData.business_goal}
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

/**
 * AI: Извлекает чистое название отеля из рекламного текста или URL.
 */
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

/**
 * AI: Предсказывает точное название отеля для OpenStreetMap и ожидаемый адрес.
 */
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

module.exports = { generateScript, extractCleanHotelName, predictOsmHotelData, buildFallbackScript };
