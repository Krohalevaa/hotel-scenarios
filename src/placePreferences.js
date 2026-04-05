const DEFAULT_RADIUS_METERS = 3000;

const PLACE_CATEGORY_DEFINITIONS = {
    shopping: {
        label: 'Shopping',
        keywords: ['shopping', 'mall', 'boutique', 'market', 'retail', 'department store', 'outlet', 'store', 'plaza', 'fashion', 'souvenir'],
        osm: {
            shop: ['mall', 'department_store', 'supermarket', 'boutique', 'clothes', 'shoes', 'jewelry', 'gift', 'sports', 'beauty', 'bag', 'watches'],
            amenity: ['marketplace']
        }
    },
    sport: {
        label: 'Sport',
        keywords: ['sport', 'sports', 'stadium', 'arena', 'fitness', 'gym', 'pool', 'swimming', 'tennis', 'football', 'soccer', 'basketball', 'ice rink', 'skatepark', 'climbing', 'yoga', 'padel'],
        osm: {
            leisure: ['sports_centre', 'fitness_centre', 'pitch', 'stadium', 'swimming_pool', 'track', 'ice_rink', 'horse_riding', 'golf_course'],
            building: ['stadium', 'sports_hall', 'grandstand'],
            sport: ['*']
        }
    },
    family_kids: {
        label: 'Family & Kids',
        keywords: ['children', 'kids', 'family', 'playground', 'zoo', 'aquarium', 'theme park', 'amusement', 'water park', 'trampoline', 'family entertainment', 'family fun'],
        osm: {
            leisure: ['playground', 'water_park', 'miniature_golf', 'amusement_arcade'],
            tourism: ['theme_park', 'zoo', 'aquarium', 'attraction'],
            amenity: ['childcare', 'kindergarten']
        }
    },
    romance_honeymoon: {
        label: 'Romance & Honeymoon',
        keywords: ['honeymoon', 'romantic', 'romance', 'sunset', 'viewpoint', 'garden', 'fine dining', 'couple', 'date night', 'wine', 'anniversary'],
        osm: {
            tourism: ['viewpoint', 'attraction', 'gallery'],
            leisure: ['park', 'garden'],
            amenity: ['restaurant', 'cafe', 'bar']
        }
    },
    culture_history: {
        label: 'Culture & History',
        keywords: ['culture', 'museum', 'gallery', 'theatre', 'theater', 'opera', 'art', 'exhibition', 'concert hall', 'cultural center', 'history', 'historic', 'monument', 'memorial', 'castle', 'fort', 'heritage', 'landmark'],
        osm: {
            tourism: ['museum', 'gallery', 'attraction', 'artwork'],
            amenity: ['theatre', 'arts_centre', 'cinema', 'library'],
            historic: ['museum', 'monument', 'memorial', 'castle', 'fort', 'ruins', 'archaeological_site']
        }
    },
    nature_outdoors: {
        label: 'Nature & Outdoors',
        keywords: ['nature', 'park', 'garden', 'lake', 'beach', 'trail', 'outdoors', 'hiking', 'botanical', 'waterfront', 'scenic', 'mountain'],
        osm: {
            leisure: ['park', 'garden', 'nature_reserve'],
            natural: ['beach', 'water', 'wood', 'peak'],
            tourism: ['viewpoint', 'attraction']
        }
    },
    food_dining: {
        label: 'Food & Dining',
        keywords: ['food', 'restaurant', 'dining', 'cafe', 'coffee', 'brunch', 'bakery', 'barbecue', 'local cuisine', 'gastronomy', 'fine dining', 'tasting'],
        osm: {
            amenity: ['restaurant', 'cafe', 'fast_food', 'bar', 'pub', 'food_court', 'biergarten'],
            shop: ['bakery', 'confectionery', 'wine', 'cheese']
        }
    },
    nightlife_bar: {
        label: 'Nightlife & Bar',
        keywords: ['nightlife', 'night club', 'cocktail', 'bar', 'pub', 'club', 'live music', 'late night', 'rooftop bar', 'speakeasy'],
        osm: {
            amenity: ['bar', 'pub', 'nightclub', 'casino'],
            leisure: ['dance']
        }
    },
    wellness_relax: {
        label: 'Wellness & Relax',
        keywords: ['wellness', 'spa', 'massage', 'sauna', 'relax', 'meditation', 'thermal', 'beauty', 'retreat', 'recovery'],
        osm: {
            leisure: ['spa', 'fitness_centre', 'swimming_pool'],
            amenity: ['spa', 'sauna', 'clinic']
        }
    }
};

const PREFERENCE_ALIASES = {
    shopping: 'shopping',
    shop: 'shopping',
    retail: 'shopping',
    sport: 'sport',
    sports: 'sport',
    fitness: 'sport',
    gym: 'sport',
    kids: 'family_kids',
    kid: 'family_kids',
    child: 'family_kids',
    children: 'family_kids',
    family: 'family_kids',
    honeymoon: 'romance_honeymoon',
    romance: 'romance_honeymoon',
    romantic: 'romance_honeymoon',
    couple: 'romance_honeymoon',
    culture: 'culture_history',
    cultural: 'culture_history',
    art: 'culture_history',
    history: 'culture_history',
    historic: 'culture_history',
    museum: 'culture_history',
    nature: 'nature_outdoors',
    outdoor: 'nature_outdoors',
    outdoors: 'nature_outdoors',
    hiking: 'nature_outdoors',
    food: 'food_dining',
    dining: 'food_dining',
    restaurant: 'food_dining',
    nightlife: 'nightlife_bar',
    night: 'nightlife_bar',
    bar: 'nightlife_bar',
    pub: 'nightlife_bar',
    wellness: 'wellness_relax',
    spa: 'wellness_relax',
    relax: 'wellness_relax'
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
