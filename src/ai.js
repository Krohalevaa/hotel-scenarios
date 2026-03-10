const axios = require('axios');
const config = require('./config');

/**
 * Direct Azure OpenAI REST API call (no LangChain needed).
 * Endpoint: https://{instance}.openai.azure.com/openai/deployments/{deployment}/chat/completions?api-version={version}
 */
async function azureChat(systemMessage, userMessage, deployment) {
    const url = `https://${config.AZURE_OPENAI_API_INSTANCE_NAME}.openai.azure.com/openai/deployments/${deployment}/chat/completions?api-version=${config.AZURE_OPENAI_API_VERSION}`;

    const body = {
        messages: [
            { role: 'system', content: systemMessage },
            { role: 'user', content: userMessage }
        ]
    };

    const response = await axios.post(url, body, {
        headers: {
            'api-key': config.AZURE_OPENAI_API_KEY,
            'Content-Type': 'application/json'
        }
    });

    return response.data.choices[0].message.content;
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
4. Если нет координат (\`geo_lat\`, \`geo_lon\`), реши оставить их NULL.
5. Проверь строки на наличие одинарных кавычек (') и экранируй их (заменяй на '').

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

### 4. ОБРАБОТКА КООРДИНАТ:
   - Вставляй как есть (Float64), если null — ставь NULL.`;

    const userMessage = `Вот сырой JSON с данными об отеле:
${JSON.stringify(rawData, null, 2)}

Твоя задача:
1. Проанализируй этот JSON.
2. Извлеки данные согласно правилам.
3. Сформируй SQL INSERT запрос согласно твоему системному промпту.
Верни только JSON объект: { "sql": "..." }`;

    try {
        const text = await azureChat(systemMessage, userMessage, config.AZURE_OPENAI_DEPLOYMENT_SQL);
        // Strip possible markdown code block wrapper
        const clean = text.replace(/^```[a-z]*\n?/i, '').replace(/```$/m, '').trim();
        const parsed = JSON.parse(clean);
        return parsed.sql || null;
    } catch (err) {
        console.error('AI Schema Mapping Error:', err.response?.data || err.message);
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
        const scriptText = await azureChat(systemMessage, userMessage, config.AZURE_OPENAI_DEPLOYMENT_SCRIPT);
        return scriptText.trim();
    } catch (err) {
        console.error('AI Script Writer Error:', err.response?.data || err.message);
        return null;
    }
}

module.exports = { generateSchemaSQL, generateScript };
