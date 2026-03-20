const { createClient } = require('@supabase/supabase-js');
const config = require('./config');
const logger = require('./logger');

const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
        autoRefreshToken: false,
        persistSession: false
    }
});

function ensureSupabaseConfigured() {
    if (!config.SUPABASE_URL || !config.SUPABASE_SERVICE_ROLE_KEY) {
        throw new Error('Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
    }
}

function normalizeAttraction(attraction) {
    if (typeof attraction === 'string') {
        return {
            attraction_name: attraction
        };
    }

    return {
        attraction_name: attraction?.name || attraction?.attraction_name || 'Unknown attraction'
    };
}

function normalizeKeyFeatures(features) {
    if (!Array.isArray(features)) {
        return [];
    }

    return features
        .map((item) => String(item || '').trim())
        .filter(Boolean)
        .slice(0, 5);
}

async function saveScript(scriptData) {
    ensureSupabaseConfigured();

    const payload = {
        id: scriptData.id,
        user_id: scriptData.user_id,
        contact_email: scriptData.contact_email || null,
        hotel_url: scriptData.hotel_url || scriptData.hotel_website_url || null,
        business_goal: scriptData.business_goal || null,
        city: scriptData.city || null,
        language: scriptData.language || 'Russian',
        status: scriptData.status || 'new',
        hotel_name: scriptData.hotel_name || null,
        final_script: scriptData.final_script || null
    };

    Object.keys(payload).forEach((key) => {
        if (payload[key] === undefined) {
            delete payload[key];
        }
    });

    const { data, error } = await supabase
        .from('hotel_scenarios')
        .upsert(payload, { onConflict: 'id' })
        .select()
        .single();

    if (error) {
        logger.error(`Supabase saveScript error: ${error.message}`);
        throw error;
    }

    logger.info(`Scenario record saved in Supabase: ${data.id}`);
    return data;
}

async function saveAttractions(scenarioId, hotelName, attractions) {
    ensureSupabaseConfigured();

    if (!scenarioId || !Array.isArray(attractions) || attractions.length === 0) {
        return [];
    }

    const rows = attractions.map((attraction) => ({
        scenario_id: scenarioId,
        hotel_name: hotelName || null,
        ...normalizeAttraction(attraction)
    }));

    const { data, error } = await supabase
        .from('hotel_attractions')
        .insert(rows)
        .select();

    if (error) {
        logger.error(`Supabase saveAttractions error: ${error.message}`);
        throw error;
    }

    logger.info(`Saved ${rows.length} attractions for scenario ${scenarioId}.`);
    return data || [];
}

async function saveHotelSourceData(sourceData) {
    ensureSupabaseConfigured();

    if (!sourceData?.scenario_id) {
        throw new Error('scenario_id is required to save hotel source data.');
    }

    const payload = {
        scenario_id: sourceData.scenario_id,
        hotel_url: sourceData.hotel_url || sourceData.hotel_website_url || null,
        hotel_name: sourceData.hotel_name || null,
        city: sourceData.city || null,
        country: sourceData.country || null,
        address: sourceData.address || null,
        latitude: sourceData.latitude ?? sourceData.geo_lat ?? null,
        longitude: sourceData.longitude ?? sourceData.geo_lon ?? null,
        attractions_found: Boolean(sourceData.attractions_found),
        key_features: normalizeKeyFeatures(sourceData.key_features)
    };

    const { data, error } = await supabase
        .from('hotel_source_data')
        .upsert(payload, { onConflict: 'scenario_id' })
        .select()
        .single();

    if (error) {
        logger.error(`Supabase saveHotelSourceData error: ${error.message}`);
        throw error;
    }

    logger.info(`Hotel source data saved for scenario ${sourceData.scenario_id}.`);
    return data;
}

async function updateScriptStatus(scenarioId, status, finalScript = null) {
    ensureSupabaseConfigured();

    if (!scenarioId) {
        throw new Error('scenarioId is required to update script status.');
    }

    const updatePayload = {
        status
    };

    if (finalScript !== null) {
        updatePayload.final_script = finalScript;
    }

    const { data, error } = await supabase
        .from('hotel_scenarios')
        .update(updatePayload)
        .eq('id', scenarioId)
        .select()
        .single();

    if (error) {
        logger.error(`Supabase updateScriptStatus error: ${error.message}`);
        throw error;
    }

    logger.info(`Updated scenario ${scenarioId} status to ${status}.`);
    return data;
}

async function getUserScripts(userId) {
    ensureSupabaseConfigured();

    const { data, error } = await supabase
        .from('hotel_scenarios')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });

    if (error) {
        logger.error(`Supabase getUserScripts error: ${error.message}`);
        throw error;
    }

    return data || [];
}

async function getUserScriptById(userId, scenarioId) {
    ensureSupabaseConfigured();

    const { data, error } = await supabase
        .from('hotel_scenarios')
        .select('*, hotel_attractions(*), hotel_source_data(*)')
        .eq('user_id', userId)
        .eq('id', scenarioId)
        .single();

    if (error) {
        logger.error(`Supabase getUserScriptById error: ${error.message}`);
        throw error;
    }

    return data;
}

async function getProfile(userId) {
    ensureSupabaseConfigured();

    const { data, error } = await supabase
        .from('user_profiles')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle();

    if (error) {
        logger.error(`Supabase getProfile error: ${error.message}`);
        throw error;
    }

    return data;
}

async function upsertProfile(userId, profileData) {
    ensureSupabaseConfigured();

    const payload = {
        user_id: userId,
        first_name: profileData.first_name || null,
        last_name: profileData.last_name || null,
        email: profileData.email,
        avatar_url: profileData.avatar_url || null,
        updated_at: new Date().toISOString()
    };

    const { data, error } = await supabase
        .from('user_profiles')
        .upsert(payload, { onConflict: 'user_id' })
        .select()
        .single();

    if (error) {
        logger.error(`Supabase upsertProfile error: ${error.message}`);
        throw error;
    }

    return data;
}

async function ensureAvatarBucket() {
    ensureSupabaseConfigured();

    const bucketName = 'avatars';
    const { data: bucket, error } = await supabase.storage.getBucket(bucketName);

    if (!error && bucket) {
        logger.info(`Avatar bucket is available: ${bucket.name}`);
        return bucket;
    }

    logger.warn(`Avatar bucket check failed: ${error?.message || 'Bucket not found'}. Attempting to create bucket ${bucketName}.`);

    const { data: createdBucket, error: createError } = await supabase.storage.createBucket(bucketName, {
        public: true,
        fileSizeLimit: 5 * 1024 * 1024,
        allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif']
    });

    if (createError) {
        logger.error(`Supabase ensureAvatarBucket create error: ${createError.message}`);
        throw createError;
    }

    logger.info(`Avatar bucket created: ${createdBucket.name}`);
    return createdBucket;
}

async function uploadAvatar(userId, fileBuffer, contentType = 'image/jpeg') {
    ensureSupabaseConfigured();

    const bucketName = 'avatars';
    const extension = contentType === 'image/png'
        ? 'png'
        : contentType === 'image/webp'
            ? 'webp'
            : contentType === 'image/gif'
                ? 'gif'
                : contentType === 'image/heic'
                    ? 'heic'
                    : contentType === 'image/heif'
                        ? 'heif'
                        : 'jpg';
    const filePath = `${userId}/avatar.${extension}`;

    logger.info(`Uploading avatar for user ${userId}: bucket=${bucketName}, path=${filePath}, contentType=${contentType}, size=${fileBuffer?.length || 0}`);

    await ensureAvatarBucket();

    const { error } = await supabase.storage
        .from(bucketName)
        .upload(filePath, fileBuffer, {
            contentType,
            upsert: true
        });

    if (error) {
        logger.error(`Supabase uploadAvatar error: ${error.message}`);
        throw error;
    }

    const { data } = supabase.storage.from(bucketName).getPublicUrl(filePath);
    const publicUrl = data.publicUrl;

    logger.info(`Avatar uploaded successfully for user ${userId}: ${publicUrl}`);
    return {
        path: filePath,
        publicUrl,
        avatar_url: publicUrl
    };
}

module.exports = {
    saveScript,
    saveAttractions,
    saveHotelSourceData,
    updateScriptStatus,
    getUserScripts,
    getUserScriptById,
    getProfile,
    upsertProfile,
    uploadAvatar,
    supabase
};
