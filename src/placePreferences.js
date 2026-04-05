const DEFAULT_RADIUS_METERS = 3000;

const PLACE_CATEGORY_DEFINITIONS = {
    sports: {
        label: 'Sports',
        keywords: ['sport', 'sports', 'stadium', 'arena', 'fitness', 'gym', 'pool', 'swimming', 'tennis', 'football', 'soccer', 'basketball', 'ice rink', 'skatepark', 'climbing', 'yoga'],
        osm: {
            leisure: ['sports_centre', 'fitness_centre', 'pitch', 'stadium', 'swimming_pool', 'track', 'ice_rink', 'horse_riding', 'golf_course'],
            building: ['stadium', 'sports_hall', 'grandstand'],
            sport: ['*']
        }
    },
    shopping: {
        label: 'Shopping',
        keywords: ['shopping', 'mall', 'boutique', 'market', 'retail', 'department store', 'outlet', 'store', 'plaza'],
        osm: {
            shop: ['mall', 'department_store', 'supermarket', 'boutique', 'clothes', 'shoes', 'jewelry', 'gift', 'sports', 'beauty'],
            amenity: ['marketplace']
        }
    },
    children: {
        label: 'Family & Kids',
        keywords: ['children', 'kids', 'family', 'playground', 'zoo', 'aquarium', 'theme park', 'amusement', 'water park', 'trampoline', 'family entertainment'],
        osm: {
            leisure: ['playground', 'water_park', 'miniature_golf', 'amusement_arcade'],
            tourism: ['theme_park', 'zoo', 'aquarium', 'attraction'],
            amenity: ['childcare', 'kindergarten']
        }
    },
    honeymoon: {
        label: 'Romance & Honeymoon',
        keywords: ['honeymoon', 'romantic', 'romance', 'sunset', 'viewpoint', 'garden', 'fine dining', 'couple', 'date night', 'wine'],
        osm: {
            tourism: ['viewpoint', 'attraction', 'gallery'],
            leisure: ['park', 'garden'],
            amenity: ['restaurant', 'cafe', 'bar']
        }
    },
    culture: {
        label: 'Culture',
        keywords: ['culture', 'museum', 'gallery', 'theatre', 'theater', 'opera', 'art', 'exhibition', 'concert hall', 'cultural center'],
        osm: {
            tourism: ['museum', 'gallery', 'attraction', 'artwork'],
            amenity: ['theatre', 'arts_centre', 'cinema', 'library'],
            historic: ['museum']
        }
    },
    history: {
        label: 'History',
        keywords: ['history', 'historic', 'monument', 'memorial', 'castle', 'fort', 'heritage', 'landmark'],
        osm: {
            historic: ['monument', 'memorial', 'castle', 'fort', 'ruins', 'archaeological_site'],
            tourism: ['attraction']
        }
    },
    nature: {
        label: 'Nature & Outdoors',
        keywords: ['nature', 'park', 'garden', 'lake', 'beach', 'trail', 'outdoors', 'hiking', 'botanical', 'waterfront'],
        osm: {
            leisure: ['park', 'garden', 'nature_reserve'],
            natural: ['beach', 'water', 'wood', 'peak'],
            tourism: ['viewpoint', 'attraction']
        }
    },
    food: {
        label: 'Food & Dining',
        keywords: ['food', 'restaurant', 'dining', 'cafe', 'coffee', 'brunch', 'bakery', 'barbecue', 'local cuisine', 'gastronomy'],
        osm: {
            amenity: ['restaurant', 'cafe', 'fast_food', 'bar', 'pub', 'food_court', 'biergarten'],
            shop: ['bakery', 'confectionery', 'wine', 'cheese']
        }
    },
    entertainment: {
        label: 'Entertainment',
        keywords: ['entertainment', 'cinema', 'bowling', 'arcade', 'concert', 'show', 'fun', 'escape room', 'casino'],
        osm: {
            amenity: ['cinema', 'casino', 'theatre', 'nightclub'],
            leisure: ['amusement_arcade', 'escape_game', 'bowling_alley', 'water_park'],
            tourism: ['theme_park', 'attraction']
        }
    },
    nightlife: {
        label: 'Nightlife',
        keywords: ['nightlife', 'night club', 'cocktail', 'bar', 'pub', 'club', 'live music', 'late night'],
        osm: {
            amenity: ['bar', 'pub', 'nightclub', 'casino'],
            leisure: ['dance']
        }
    },
    wellness: {
        label: 'Wellness & Relax',
        keywords: ['wellness', 'spa', 'massage', 'sauna', 'relax', 'meditation', 'thermal', 'beauty'],
        osm: {
            leisure: ['spa', 'fitness_centre', 'swimming_pool'],
            amenity: ['spa', 'sauna', 'clinic']
        }
    }
};

const PREFERENCE_ALIASES = {
    sport: 'sports',
    sports: 'sports',
    fitness: 'sports',
    gym: 'sports',
    shopping: 'shopping',
    shop: 'shopping',
    kids: 'children',
    kid: 'children',
    child: 'children',
    children: 'children',
    family: 'children',
    honeymoon: 'honeymoon',
    romance: 'honeymoon',
    romantic: 'honeymoon',
    culture: 'culture',
    cultural: 'culture',
    art: 'culture',
    history: 'history',
    historic: 'history',
    nature: 'nature',
    outdoor: 'nature',
    outdoors: 'nature',
    food: 'food',
    dining: 'food',
    restaurant: 'food',
    entertainment: 'entertainment',
    fun: 'entertainment',
    nightlife: 'nightlife',
    night: 'nightlife',
    wellness: 'wellness',
    spa: 'wellness',
    relax: 'wellness'
};

function normalizeText(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s,&/-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function parseGuestPreference(preference) {
    const normalized = normalizeText(preference);
    if (!normalized) {
        return [];
    }

    const tokens = normalized
        .split(/[,/;&]|\band\b|\bor\b/)
        .map((item) => item.trim())
        .filter(Boolean);

    const categories = new Set();

    for (const token of tokens) {
        if (PREFERENCE_ALIASES[token]) {
            categories.add(PREFERENCE_ALIASES[token]);
            continue;
        }

        for (const [category, definition] of Object.entries(PLACE_CATEGORY_DEFINITIONS)) {
            if (definition.keywords.some((keyword) => token.includes(keyword) || keyword.includes(token))) {
                categories.add(category);
            }
        }
    }

    return [...categories];
}

function buildPreferenceSummary(preference) {
    const categories = parseGuestPreference(preference);
    return categories.map((category) => ({
        key: category,
        label: PLACE_CATEGORY_DEFINITIONS[category]?.label || category
    }));
}

function getCategoryDefinition(category) {
    return PLACE_CATEGORY_DEFINITIONS[category] || null;
}

function getAllCategoryKeys() {
    return Object.keys(PLACE_CATEGORY_DEFINITIONS);
}

module.exports = {
    DEFAULT_RADIUS_METERS,
    PLACE_CATEGORY_DEFINITIONS,
    parseGuestPreference,
    buildPreferenceSummary,
    getCategoryDefinition,
    getAllCategoryKeys,
    normalizeText
};
