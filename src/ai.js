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
    
    // Task 12: Add retries and timeouts
    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const response = await axios.post(url, {
                messages: messages,
                max_tokens: 800,
                temperature: 0.7,
            }, {
                headers: {
                    'Content-Type': 'application/json',
                    'api-key': config.AZURE_OPENAI_API_KEY,
                },
                timeout: 120000 // 2 minutes timeout
            });
            return response.data.choices[0].message.content;
        } catch (error) {
            lastError = error;
            logger.warn(`AI attempt ${attempt + 1} failed: ${error.message}`);
            // Wait before retry
            if (attempt < 2) await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
        }
    }
    throw new Error(`AI Request failed after 3 attempts: ${lastError.message}`);
}

async function generateSchemaSQL(rawData) {
    const systemMessage = `Ты — Senior Data Engineer и эксперт по ClickHouse.
Твоя задача — преобразовать входной JSON с сырыми данными об отеле в готовый SQL-запрос INSERT для таблицы \`hotel_profile\`.

### 1. ИНСТРУКЦИЯ ПО МЫШЛЕНИЮ (Reasoning)
Ты должен "подумать" перед генерацией. Запиши ход своих мыслей в поле \`_reasoning\` внутри JSON ответа.
В ходе мышления:
1. Проанализируй входные данные. Определи, какие поля есть, а каких нет.
2. Определи \`hotel_type\` (resort, business, etc.) на основе описания и удобств, если он не указан явно.
3. Сформулируй \`positioning_reasons\` (почему люди едут сюда?) и \`main_trip_purposes\` из контекста.
4. Если в JSON переданы координаты (geo_lat, geo_lon), ты ОБЯЗАН использовать их. Не пытайся решить, что они неверные или лишние.
5. ЭКРАНИРОВАНИЕ (ОЧЕНЬ ВАЖНО): 
   - Для обычных строк (String): вставляй как 'значение', удваивай кавычки внутри (' -> '').
   - Для массивов (Array(String)): вставляй как ['эл1', 'эл2']. НЕ ПИШИ [''значение''], используй только одну кавычку для обрамления элемента массива. Если внутри элемента есть кавычка - удваивай.

### 2. СТРОГАЯ СХЕМА ТАБЛИЦЫ (Target Schema)
Ты можешь использовать ТОЛЬКО эти колонки. Запрещено выдумывать свои (никаких \`name\`, \`desc\` и т.д.).

Таблица: \`hotel_profile\`
- hotel_domain (String)        — Домен сайта (например: "hilton.com")
- hotel_name (String)          — Название отеля
- address (String)             — Полный адрес или NULL
- city (String)                — Город (выдели из адреса) или NULL
- country (String)             — Страна (выдели из адреса) или NULL
- geo_lat (Float64)            — Широта или NULL
- geo_lon (Float64)            — Долгота или NULL
- hotel_type (String)          — Тип: 'business', 'resort', 'family', 'boutique'
- positioning_reasons (Array(String)) — Причины выбора
- core_description (String)    — Краткое описание
- special_services (Array(String))    — Фишки
- main_trip_purposes (Array(String))  — Цели
- source_url (String)          — URL источника
- source_captured_at (DateTime)— Дата сбора

### 3. ФОРМАТ ОТВЕТА
Верни строго валидный JSON. Никакого текста до или после JSON.

Пример структуры ответа:
{
  "_reasoning": "...",
  "sql": "INSERT INTO hotel_profile (...) VALUES (...);"
}

### 4. КРИТИЧЕСКИЕ ПРАВИЛА ПО КООРДИНАТАМ:
   - Вставляй СТРОГО те значения geo_lat и geo_lon, которые переданы во входящем JSON. ЗАПРЕЩЕНО заменять их на NULL, если во входных данных есть числа.`;

    const userMessage = `Вот сырой JSON с данными об отеле:
${JSON.stringify(rawData, null, 2)}

Твоя задача:
1. Проанализируй этот JSON.
2. Извлеки данные согласно правилам.
3. Сформируй SQL INSERT запрос согласно твоему системному промпту.
Верни только JSON объект: { "sql": "..." }`;

    try {
        logger.debug(`AI: Starting Schema SQL generation for hotel...`);
        const text = await azureChat(systemMessage, userMessage, config.AZURE_OPENAI_DEPLOYMENT_SQL);
        // Strip possible markdown code block wrapper
        const clean = text.replace(/^```[a-z]*\n?/i, '').replace(/```$/m, '').trim();
        const parsed = JSON.parse(clean);
        logger.debug('AI: Schema SQL generated successfully.');
        return parsed.sql || null;
    } catch (err) {
        logger.error(`AI Schema Mapping Error: ${err.response?.data || err.message}`);
        return null;
    }
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
        logger.debug('AI: Script Writer finished.');
        return scriptText.trim();
    } catch (err) {
        logger.error(`AI Script Writer Error: ${err.response?.data || err.message}`);
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

module.exports = { generateSchemaSQL, generateScript, extractCleanHotelName, predictOsmHotelData };
