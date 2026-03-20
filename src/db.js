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
            attraction_name: attraction,
            category: 'general'
        };
    }

    return {
        attraction_name: attraction?.name || attraction?.attraction_name || 'Unknown attraction',
        category: attraction?.category || 'general'
    };
}

async function saveScript(scriptData) {
    ensureSupabaseConfigured();

    const payload = {
        id: scriptData.id,
        user_id: scriptData.user_id,
        contact_email: scriptData.contact_email || null,
        hotel_website_url: scriptData.hotel_website_url || null,
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

    const query = supabase
        .from('video_scripts')
        .upsert(payload, { onConflict: 'id' })
        .select()
        .single();

    const { data, error } = await query;

    if (error) {
        logger.error(`Supabase saveScript error: ${error.message}`);
        throw error;
    }

    logger.info(`Script record saved in Supabase: ${data.id}`);
    return data;
}

async function saveAttractions(scriptId, attractions) {
    ensureSupabaseConfigured();

    if (!scriptId || !Array.isArray(attractions) || attractions.length === 0) {
        return [];
    }

    const rows = attractions.map((attraction) => ({
        script_id: scriptId,
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

    logger.info(`Saved ${rows.length} attractions for script ${scriptId}.`);
    return data || [];
}

async function updateScriptStatus(scriptId, status, finalScript = null) {
    ensureSupabaseConfigured();

    if (!scriptId) {
        throw new Error('scriptId is required to update script status.');
    }

    const updatePayload = {
        status
    };

    if (finalScript !== null) {
        updatePayload.final_script = finalScript;
    }

    const { data, error } = await supabase
        .from('video_scripts')
        .update(updatePayload)
        .eq('id', scriptId)
        .select()
        .single();

    if (error) {
        logger.error(`Supabase updateScriptStatus error: ${error.message}`);
        throw error;
    }

    logger.info(`Updated script ${scriptId} status to ${status}.`);
    return data;
}

async function getUserScripts(userId) {
    ensureSupabaseConfigured();

    const { data, error } = await supabase
        .from('video_scripts')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });

    if (error) {
        logger.error(`Supabase getUserScripts error: ${error.message}`);
        throw error;
    }

    return data || [];
}

async function getUserScriptById(userId, scriptId) {
    ensureSupabaseConfigured();

    const { data, error } = await supabase
        .from('video_scripts')
        .select('*, hotel_attractions(*)')
        .eq('user_id', userId)
        .eq('id', scriptId)
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
        .from('profiles')
        .select('*')
        .eq('id', userId)
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
        id: userId,
        full_name: profileData.full_name || null,
        avatar_url: profileData.avatar_url || null,
        updated_at: new Date().toISOString()
    };

    const { data, error } = await supabase
        .from('profiles')
        .upsert(payload, { onConflict: 'id' })
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

    await upsertProfile(userId, { avatar_url: publicUrl });

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
    updateScriptStatus,
    getUserScripts,
    getUserScriptById,
    getProfile,
    upsertProfile,
    uploadAvatar,
    supabase
};
