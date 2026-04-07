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
First determine the best 2 or 3 attraction categories for this specific guest and hotel context.
Then select the most useful nearby places for a hotel marketing video script, prioritizing places from those categories.
If the guest preference is vague, still infer the best-fit categories from the business goal, hotel context, and available places.
Return strict JSON only with this shape:
{
  "selectedCategories": ["category"],
  "recommendedPlaces": [{ "name": "Place name", "category": "category", "reason": "short reason" }]
}
Rules:
- selectedCategories must contain 2 or 3 items whenever possible.
- Use only categories that exist in the provided places data.
- recommendedPlaces should strongly match selectedCategories.
- Keep only the most relevant and diverse places.`;

    const userMessage = `Hotel: ${hotelData.hotel_name}
City: ${hotelData.city}
Business goal: ${hotelData.business_goal}
Guest preference: ${hotelData.guest_preference || 'not specified'}
Available categories from search: ${JSON.stringify(hotelData.available_place_categories || [])}
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

function getPlaceName(place) {
    if (!place) return '';
    return String(place.name || place.attraction_name || '').trim();
}

function getScriptAttractionCandidates(hotelData, limit = 5) {
    const recommendedNames = Array.isArray(hotelData.recommended_places)
        ? hotelData.recommended_places.map((item) => getPlaceName(item))
        : [];

    const discoveredNames = Array.isArray(hotelData.discovered_attractions?.[0]?.recommended_places)
        ? hotelData.discovered_attractions[0].recommended_places.map((item) => getPlaceName(item))
        : [];

    const nearbyNames = Array.isArray(hotelData.nearby_attractions)
        ? hotelData.nearby_attractions.map((item) => String(item || '').trim())
        : [];

    return normalizeList([
        ...recommendedNames,
        ...nearbyNames,
        ...discoveredNames
    ]).slice(0, limit);
}

function escapeRegExp(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function scriptMentionsAttractions(scriptText, attractionNames = []) {
    if (!scriptText) return false;

    const normalizedScript = String(scriptText).toLowerCase();
    const validNames = normalizeList(attractionNames).filter((name) => name.length >= 3);

    if (!validNames.length) {
        return true;
    }

    return validNames.some((name) => {
        const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegExp(name.toLowerCase())}([^a-z0-9]|$)`, 'i');
        return pattern.test(normalizedScript);
    });
}

function buildStructuredFallbackScript(hotelData) {
    const hotelName = hotelData.hotel_name || 'this hotel';
    const city = hotelData.city || hotelData.location || hotelData.address || 'City';
    const location = hotelData.location || hotelData.address || hotelData.city || 'a great location';
    const businessGoal = hotelData.business_goal || 'increase direct bookings';
    const guestPreference = String(hotelData.guest_preference || '').trim();
    const description = String(hotelData.description || '').trim();
    const amenities = normalizeList(hotelData.amenities).slice(0, 6);
    const offers = normalizeList(hotelData.special_offers).slice(0, 3);
    const attractions = getScriptAttractionCandidates(hotelData, 3);

    const visualBase = description || `${hotelName} in ${location}`;
    const amenityText = amenities.length ? amenities.join(', ') : 'comfort, style, and convenience';
    const attractionText = attractions.length ? attractions.join(' & ') : location;
    const offerText = offers.length ? offers.join(', ') : `Book now for ${businessGoal}`;
    const preferenceText = guestPreference || 'memorable stays';
    const preferenceVisual = guestPreference
        ? `quick lifestyle cut that reflects ${guestPreference}`
        : `quick lifestyle cut that shows ${amenityText}`;
    const preferenceVoiceover = guestPreference
        ? `Made for ${guestPreference}, with ${amenityText} built into the stay.`
        : `Think ${amenityText} in one stay.`;
    const locationVisual = attractions.length
        ? `quick cut from hotel exterior to nearby highlights: signage, street approach, and guest moments at ${attractionText}.`
        : `quick cut from hotel exterior to nearby area highlights around ${attractionText}.`;
    const locationVoiceover = attractions.length
        ? `Stay here and you’re close to ${attractionText}, giving every trip more to do right outside the hotel.`
        : `You’re right by ${attractionText}, so the whole trip feels easy.`;
    const hookVoiceover = guestPreference
        ? `${hotelName} is your sign to stay in ${location} for ${preferenceText}.`
        : `${hotelName} is your sign to stay in ${location}.`;

    return [
        `15s TikTok Script – ${hotelName}, ${city}`,
        '',
        'For HeyGen – avatar ALWAYS in bottom-left corner, small, overlaid on footage.',
        'Avatar: points toward center of screen when “showing” something, then drops hands / nods to confirm.',
        '',
        '⸻',
        '',
        'Scene 1 – HOOK (0–3s)',
        `• Visual: slow zoom in on ${visualBase} with an opening mood that supports ${businessGoal}.`,
        '• Avatar: energetic smile, quick point to center.',
        `• On-screen text (center): ${hotelName} | ${businessGoal}`,
        `• Voiceover:\n“${hookVoiceover}”`,
        '',
        '⸻',
        '',
        'Scene 2 – STAY VIBE (3–6s)',
        `• Visual: ${preferenceVisual}.`,
        '• Avatar: open palm toward footage, confident nod.',
        `• On-screen text (bottom-right): ${guestPreference || amenityText}`,
        `• Voiceover:\n“${preferenceVoiceover}”`,
        '',
        '⸻',
        '',
        'Scene 3 – COMFORT & DETAILS (6–9s)',
        `• Visual: smooth pan across details that support the guest experience at ${hotelName}, highlighting ${amenityText}.`,
        '• Avatar: small hand sweep, relaxed smile.',
        `• On-screen text (top-right): ${businessGoal}`,
        `• Voiceover:\n“Everything here is built to ${businessGoal}${guestPreference ? ` for ${preferenceText}` : ''}.”`,
        '',
        '⸻',
        '',
        'Scene 4 – LOCATION (9–12s)',
        `• Visual: ${locationVisual}`,
        '• Avatar: points toward center, then nods.',
        `• On-screen text (top-left): ${attractionText}`,
        `• Voiceover:\n“${locationVoiceover}”`,
        '',
        '⸻',
        '',
        'Scene 5 – OFFER & CTA (12–15s)',
        `• Visual: fast closing shot of the strongest hotel moment with booking energy on screen, ending on a CTA that supports ${businessGoal}.`,
        '• Avatar: direct point to center, then confirm with a nod.',
        `• On-screen text (center): ${offerText}`,
        `• Voiceover:\n“${offerText} — book ${hotelName} now for ${preferenceText}.”`
    ].join('\n');
}

async function generateScript(hotelData) {
    const scriptAttractionCandidates = getScriptAttractionCandidates(hotelData, 5);
    const normalizedRecommendedPlaces = normalizeList(
        Array.isArray(hotelData.recommended_places)
            ? hotelData.recommended_places.map((item) => getPlaceName(item))
            : []
    );

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
        recommended_places: normalizedRecommendedPlaces.slice(0, 12),
        nearby_attractions: scriptAttractionCandidates.slice(0, 12),
        description: hotelData.description || null
    };

    const targetLanguage = hotelData.language || 'English';
    const nearbyAttractions = formatList(scriptAttractionCandidates, 'Not specified');

    const systemMessage = `You are a professional scriptwriter for short, dynamic TikTok/Reels commercials. You specialize in scripts for the hotel industry.

Task: Using the hotel data provided, create a script for a 15-second hotel video in the exact format shown below.

CRITICAL RULES:
- You MUST write the entire script, including title, scene titles, visuals, avatar actions, on-screen text, and voiceover, in the language specified by the Target Language field.
- Do not use English unless the Target Language is English.
- Return only the final script text.
- Do not add explanations, notes, disclaimers, fallback comments, or meta-text.
- Never output phrases like “Use available hotel facts without inventing extra amenities.” or “No confirmed attractions were found, so focus on hotel-led experience.”
- If some data is missing, still produce a complete 5-scene script using only confirmed facts from the input.
- Do not invent amenities, offers, attractions, or claims that are not supported by the input.
- The script MUST explicitly reflect all three inputs whenever they are available: (1) Business Goal, (2) Guest Preference, and (3) specific discovered nearby attractions / recommended places.
- Guest Preference is mandatory to reflect in the creative angle, wording, and visuals whenever it is provided. Example: if the guest preference mentions family travel or children, the script must clearly emphasize family-friendly comfort, easy outings, and child-relevant moments.
- Nearby attractions are mandatory to mention when they are available in the input. Use the actual confirmed attraction names from Recommended Places / Nearby Attractions, and make them part of the scenario and shot ideas.
- Scene 4 must be built around nearby attractions when they are available, with concrete production-ready footage ideas showing what to film near the hotel.
- Scene 1 and Scene 5 must reinforce the Business Goal directly and clearly.

Original format (strictly adhere to this structure and markup):

15s TikTok Script – [Hotel Name], [City]

For HeyGen – avatar ALWAYS in bottom-left corner, small, overlaid on footage.
Avatar: points toward center of screen when “showing” something, then drops hands / nods to confirm.

⸻

Scene 1 – HOOK (0–3s)
• Visual: [Description]
• Avatar: [Pose and Action]
• On-screen text (position): [Text]
• Voiceover:
“[Phrase]”

⸻

Scene 2 – STAY VIBE (3–6s)
• Visual: [Description]
• Avatar: [Pose and Action]
• On-screen text (position): [Text]
• Voiceover:
“[Phrase]”

⸻

Scene 3 – COMFORT & DETAILS (6–9s)
• Visual: [Description]
• Avatar: [Pose and Action]
• On-screen text (position): [Text]
• Voiceover:
“[Phrase]”

⸻

Scene 4 – LOCATION & PERKS (9–12s)
• Visual: [Description]
• Avatar: [Pose and Action]
• On-screen text (position): [Text]
• Voiceover:
“[Phrase]”

⸻

Scene 5 – DEAL & CTA (12–15s)
• Visual: [Description]
• Avatar: [Pose and Action]
• On-screen text (position): [Text]
• Voiceover:
“[Phrase]”

Instructions for generating content:
1. The script must be for a short 15-second video and be split into exactly 5 scenes of about 3 seconds each.
2. Every scene must include all four fields: Visual, Avatar, On-screen text, and Voiceover.
3. The entire tone must strongly support the Business Goal, especially Scene 1 and Scene 5.
4. The script must explicitly incorporate the Guest Preference whenever it is provided, not just mention it once. It must shape the angle of the stay, the emotional framing, and the shot selection.
5. If the Guest Preference implies a specific audience or trip type (for example family trip, отдых с детьми, romantic escape, business travel, wellness weekend), the scenes must visibly and verbally reflect that audience or trip type.
6. Scene 4 must mention one or two specific nearby attractions when they are available in the input.
7. Scene 4 visuals must include concrete shot ideas tied to those attractions, such as what exactly to film near the hotel.
8. Scene 5 must integrate relevant Special Offers when they exist. If no offers exist, create a generic urgent CTA based on the Business Goal without mentioning missing data.
9. Visuals must be short, specific, and production-ready. Use wording like “slow zoom in”, “quick cut to”, “smooth pan”, and similar.
10. Voiceover must feel energetic, friendly, slightly intimate, and natural for a TikTok creator.
11. Use only confirmed hotel facts from the input.
12. Do not output placeholders. Replace every field with final content.
13. If Recommended Places or Nearby Attractions are present, you must use them in the final script as named local highlights, not ignore them.
14. If Business Goal, Guest Preference, and nearby attractions are all present, all three must be clearly visible in the final script.`;

    const userMessage = `CRITICAL: You MUST write the entire script in the language specified in the Target Language field.

Create a short 15-second hotel video script with exactly 5 scenes of about 3 seconds each.
Each scene must be detailed, concise, and production-ready.
Do not include any explanations or service text outside the final script.

NON-NEGOTIABLE PRIORITIES FOR THIS SCRIPT:
1. The final script must clearly reflect the Business Goal.
2. The final script must clearly reflect the Guest Preference when it is provided.
3. The final script must clearly mention specific discovered nearby attractions / recommended places when they are provided.
4. Do not ignore any of these three dimensions if they exist in the input.
5. If the Guest Preference says family trip / children / kids, make the script noticeably family-oriented in both visuals and voiceover.
6. If nearby attractions are available, include them as concrete local highlights and suggest what footage to capture there.

Hotel Name: ${hotelData.hotel_name || 'Not specified'}
City: ${hotelData.city || 'Not specified'}
Location: ${hotelData.location || hotelData.address || hotelData.city || 'Not specified'}
Description: ${hotelData.description || 'Not specified'}
Special Offers: ${formatList(hotelData.special_offers, 'Not specified')}
Amenities: ${formatList(hotelData.amenities, 'Not specified')}
Photos: ${formatList(hotelData.photos, 'Not specified')}
Nearby Attractions: ${nearbyAttractions}
Business Goal: ${hotelData.business_goal || 'Not specified'}
Target Language: ${targetLanguage}
Guest Preference: ${hotelData.guest_preference || 'Not specified'}
Recommended Places: ${formatList(normalizedRecommendedPlaces, 'Not specified')}
Selected Categories: ${formatList(hotelData.selected_place_categories, 'Not specified')}
All Discovered Attractions For Mandatory Mention: ${formatList(scriptAttractionCandidates, 'Not specified')}`;

    const forbiddenPhrases = [
        'Use available hotel facts without inventing extra amenities.',
        'No confirmed attractions were found, so focus on hotel-led experience.'
    ];

    const hasValidScriptStructure = (scriptText) => {
        if (!scriptText) return false;

        const requiredMarkers = [
            'Scene 1',
            'Scene 2',
            'Scene 3',
            'Scene 4',
            'Scene 5',
            '• Visual:',
            '• Avatar:',
            '• On-screen text',
            '• Voiceover:'
        ];

        return requiredMarkers.every((marker) => scriptText.includes(marker));
    };

    const containsForbiddenPhrases = (scriptText) => forbiddenPhrases.some((phrase) => scriptText.includes(phrase));

    try {
        logger.debug(`AI: Starting Script Writer for: ${hotelData.hotel_name}`);
        const scriptText = await azureChat(systemMessage, userMessage, config.AZURE_OPENAI_DEPLOYMENT);
        const cleanScript = scriptText.trim();

        if (!hasValidScriptStructure(cleanScript) || containsForbiddenPhrases(cleanScript)) {
            logger.warn(`AI Script Writer returned invalid structure, using structured fallback for: ${hotelData.hotel_name}`);
            return buildStructuredFallbackScript(hotelData);
        }

        if (!scriptMentionsAttractions(cleanScript, scriptAttractionCandidates)) {
            logger.warn(`AI Script Writer omitted discovered attractions, using structured fallback for: ${hotelData.hotel_name}`);
            return buildStructuredFallbackScript({
                ...hotelData,
                nearby_attractions: scriptAttractionCandidates
            });
        }

        return cleanScript;
    } catch (err) {
        logger.error(`AI Script Writer Error: ${err.response?.data || err.message}`);
        logger.error(`AI Script Writer Context: hotel=${hotelData.hotel_name}, language=${hotelData.language}, businessGoal=${hotelData.business_goal}, attractionsCount=${hotelData.nearby_attractions?.length || 0}`);
        return buildStructuredFallbackScript(hotelData);
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
    const blockedNames = ['attention required!', 'access denied', 'just a moment', 'ddos-guard', '403 forbidden', 'cloudflare', 'checking your browser'];
    const normalizedHotelName = String(hotelName || '').trim();
    const normalizedBlockedName = normalizedHotelName.toLowerCase();

    if (!normalizedHotelName || blockedNames.includes(normalizedBlockedName)) {
        const extractedName = await extractCleanHotelName(normalizedHotelName || url, url);
        if (extractedName) {
            logger.warn(`Replacing invalid hotel name "${normalizedHotelName || 'empty'}" with extracted name "${extractedName}" before OSM prediction.`);
            hotelName = extractedName;
        } else {
            hotelName = normalizedHotelName || 'Hotel';
        }
    }

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
