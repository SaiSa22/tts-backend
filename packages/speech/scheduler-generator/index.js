const { createClient } = require('@supabase/supabase-js');
const sdk = require("microsoft-cognitiveservices-speech-sdk");
const AWS = require('aws-sdk');
const { DateTime } = require("luxon");

async function main(args) {
    console.log("Function started. Checking environment variables...");

    // 1. Safe Initialization
    const sbUrl = process.env.SUPABASE_URL;
    const sbKey = process.env.SUPABASE_KEY;
    
    if (!sbUrl || !sbKey) {
        console.error("CRITICAL ERROR: Missing SUPABASE_URL or SUPABASE_KEY.");
        return { body: { error: "Configuration Error: Missing Supabase Secrets" } };
    }

    const supabase = createClient(sbUrl, sbKey);
    
    if (!process.env.SPACES_ENDPOINT || !process.env.SPACES_KEY) {
        console.error("CRITICAL ERROR: Missing Spaces Configuration.");
        return { body: { error: "Configuration Error: Missing Spaces Secrets" } };
    }

    const spaces = new AWS.S3({
        endpoint: new AWS.Endpoint(process.env.SPACES_ENDPOINT),
        accessKeyId: process.env.SPACES_KEY,
        secretAccessKey: process.env.SPACES_SECRET,
        s3ForcePathStyle: true, 
        signatureVersion: 'v4'
    });

    // 2. Fetch All Users
    // OPTIMIZATION: If triggered manually, we could filter here, but fetching all is fine for now.
    const { data: users, error: userError } = await supabase
        .from('user_settings')
        .select('user_id, fetch_time, timezone');
    
    if (userError) {
        console.error("Supabase Error:", userError);
        return { body: { error: userError.message } };
    }

    console.log(`Checking ${users.length} users...`);
    const results = [];

    // 3. Process Each User
    for (const user of users) {
        if (!user.fetch_time || !user.timezone) {
            console.warn(`User ${user.user_id} missing time settings. Skipping.`);
            continue;
        }

        // --- TIMEZONE LOGIC START ---
        
        // A. What time is it for the USER right now?
        const userNow = DateTime.now().setZone(user.timezone);
        const currentLocalHour = userNow.hour;
        const targetFetchHour = parseInt(user.fetch_time.split(':')[0]);

        // --- THE FIX IS HERE ---
        // Check if this run was triggered manually for this specific user
        const isManualTrigger = (args.user_id === user.user_id);

        // B. Is it time to fetch?
        // Logic: If it is NOT a manual trigger AND the hour doesn't match, SKIP.
        if (!isManualTrigger && currentLocalHour !== targetFetchHour) {
             // Uncomment to debug:
             // console.log(`Skipping ${user.user_id}: Local ${currentLocalHour} != Target ${targetFetchHour}`);
             continue; 
        }

        if (isManualTrigger) {
            console.log(`FORCE REFRESH detected for User ${user.user_id}`);
        } else {
            console.log(`Scheduled Run for User ${user.user_id}: It is ${currentLocalHour}:00 in ${user.timezone}`);
        }

        // C. Determine "Today" for the user
        const userTodayStr = userNow.toFormat('yyyy-MM-dd');

        // --- TIMEZONE LOGIC END ---

        const { data: events } = await supabase
            .from('events')
            .select('*')
            .eq('user_id', user.user_id)
            .eq('date', userTodayStr) // Query for User's "Today"
            .order('start_time', { ascending: true })
            .limit(5);

        // If no events, we still might want to update the manifest (to show 0 events), 
        // but if you prefer skipping empty days, keep the check.
        // For a Force Refresh, usually we want to proceed even if events is empty to clear the device.
        if ((!events || events.length === 0)) {
            console.log(`No events found for user ${user.user_id} on ${userTodayStr}`);
            // OPTIONAL: If you want the device to know there are 0 events, don't continue here.
            // For now, we will stick to your logic and continue (skip manifest generation).
            continue;
        }

        const manifestEvents = [];
        let seq = 1;

        for (const event of events) {
            let publicUrl = event.audio_url;

            // Generate Audio if needed
            if (!event.processed) {
                try {
                    console.log(`Generating audio for event ${event.id}...`);
                    const audioBuffer = await generateAzureAudio(event.message);
                    const mp3Filename = `${user.user_id}_0${seq}.mp3`;

                    await spaces.putObject({
                        Bucket: process.env.SPACES_BUCKET,
                        Key: mp3Filename,
                        Body: audioBuffer,
                        ACL: 'public-read',
                        ContentType: 'audio/mpeg'
                    }).promise();

                    // Construct Public URL
                    publicUrl = `https://${process.env.SPACES_BUCKET}.${process.env.SPACES_ENDPOINT}/${mp3Filename}`;
                    if (process.env.SPACES_ENDPOINT.startsWith(process.env.SPACES_BUCKET)) {
                         publicUrl = `https://${process.env.SPACES_ENDPOINT}/${mp3Filename}`;
                    }

                    await supabase
                        .from('events')
                        .update({ audio_url: publicUrl, processed: true })
                        .eq('id', event.id);

                } catch (err) {
                    console.error(`Error processing event ${event.id}:`, err);
                    continue; 
                }
            }

            // --- TIMESTAMP CALCULATION ---
            const startParts = event.start_time.split(':');
            const endParts = event.end_time.split(':');

            const eventStartDT = userNow.set({
                hour: parseInt(startParts[0]),
                minute: parseInt(startParts[1]),
                second: 0,
                millisecond: 0
            });

            const eventEndDT = userNow.set({
                hour: parseInt(endParts[0]),
                minute: parseInt(endParts[1]),
                second: 0,
                millisecond: 0
            });

            manifestEvents.push({
                sequence: seq,
                alertStart: Math.floor(eventStartDT.toSeconds()), 
                alertEnd: Math.floor(eventEndDT.toSeconds()),      
                audio_url: publicUrl
            });
            seq++;
        }

        // --- FETCH TIME CONVERSION ---
        const nextFetchLocal = userNow.plus({ days: 1 }).set({
            hour: targetFetchHour,
            minute: parseInt(user.fetch_time.split(':')[1] || '0')
        });
        const nextFetchUtcStr = nextFetchLocal.toUTC().toFormat('HH:mm');

        const manifestPayload = {
            version: 52, // Bumping version
            user_id: user.user_id,
            generated_at: Math.floor(DateTime.now().toSeconds()),
            settings: {
                fetch_time: nextFetchUtcStr,
                timezone: user.timezone
            },
            event_count: manifestEvents.length,
            events: manifestEvents
        };

        const jsonFilename = `${user.user_id}_status.json`;
        await spaces.putObject({
            Bucket: process.env.SPACES_BUCKET,
            Key: jsonFilename,
            Body: JSON.stringify(manifestPayload),
            ACL: 'public-read',
            ContentType: 'application/json',
            CacheControl: 'max-age=60' 
        }).promise();

        results.push({ user: user.user_id, manifest: jsonFilename, utc_fetch: nextFetchUtcStr });
    }

    return { body: { processed: results.length, details: results } };
}

function generateAzureAudio(text) {
    return new Promise((resolve, reject) => {
        const speechConfig = sdk.SpeechConfig.fromSubscription(process.env.AZURE_KEY, process.env.AZURE_REGION);

        speechConfig.speechSynthesisOutputFormat = sdk.SpeechSynthesisOutputFormat.Audio16Khz32KBitRateMonoMp3;
        const synthesizer = new sdk.SpeechSynthesizer(speechConfig);
        synthesizer.speakTextAsync(text, result => {
            if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
                resolve(Buffer.from(result.audioData));
            } else {
                reject(result.errorDetails);
            }
            synthesizer.close();
        }, err => {
            synthesizer.close();
            reject(err);
        });
    });
}

exports.main = main;
