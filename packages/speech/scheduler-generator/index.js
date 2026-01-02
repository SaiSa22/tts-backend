const { createClient } = require('@supabase/supabase-js');
const sdk = require("microsoft-cognitiveservices-speech-sdk");
const AWS = require('aws-sdk');
const { DateTime } = require("luxon"); // REQUIRED: Run 'npm install luxon'

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

    // Fix: Ensure we don't double the bucket name in the URL
    // If your env var has "remindaudio.sfo3...", the SDK might make it "remindaudio.remindaudio.sfo3..."
    // We strictly use Path Style here to be safe.
    const spaces = new AWS.S3({
        endpoint: new AWS.Endpoint(process.env.SPACES_ENDPOINT),
        accessKeyId: process.env.SPACES_KEY,
        secretAccessKey: process.env.SPACES_SECRET,
        s3ForcePathStyle: true, 
        signatureVersion: 'v4'
    });

    // 2. Fetch All Users (We filter manually to handle Timezones correctly)
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

        // B. Is it time to fetch? (Compare Local Hour to Target Hour)
        // Note: This matches if the current hour in Chicago is 7 AM, etc.
        if (currentLocalHour !== targetFetchHour) {
            // Uncomment to debug specific users:
            // console.log(`Skipping ${user.user_id}: Local ${currentLocalHour} != Target ${targetFetchHour}`);
            continue; 
        }

        console.log(`Processing User ${user.user_id}: It is ${currentLocalHour}:00 in ${user.timezone}`);

        // C. Determine "Today" for the user (Database Query)
        const userTodayStr = userNow.toFormat('yyyy-MM-dd');

        // --- TIMEZONE LOGIC END ---

        const { data: events } = await supabase
            .from('events')
            .select('*')
            .eq('user_id', user.user_id)
            .eq('date', userTodayStr) // Query for User's "Today"
            .order('start_time', { ascending: true })
            .limit(5);

        if (!events || events.length === 0) {
            console.log(`No events found for user ${user.user_id} on ${userTodayStr}`);
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

                    // Construct Public URL (Virtual Host Style Preferred for Production if Certs work, Path Style otherwise)
                    // We use the Bucket Env var to build the cleaner URL manually if possible
                    publicUrl = `https://${process.env.SPACES_BUCKET}.${process.env.SPACES_ENDPOINT}/${mp3Filename}`;
                    // If Endpoint already has bucket (common error), strip it:
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

            // --- TIMESTAMP CALCULATION (Local -> UTC Unix) ---
            // We parse the HH:MM from the DB using the USER'S Timezone
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
                alertStart: Math.floor(eventStartDT.toSeconds()), // UTC Unix Timestamp
                alertEnd: Math.floor(eventEndDT.toSeconds()),     // UTC Unix Timestamp
                audio_url: publicUrl
            });
            seq++;
        }

        // --- FETCH TIME CONVERSION (Local String -> UTC String) ---
        // Device is on UTC. User wants to wake at "13:00" Chicago.
        // We assume they want to wake at the same time tomorrow.
        const nextFetchLocal = userNow.plus({ days: 1 }).set({
            hour: targetFetchHour,
            minute: parseInt(user.fetch_time.split(':')[1] || '0')
        });
        const nextFetchUtcStr = nextFetchLocal.toUTC().toFormat('HH:mm');

        const manifestPayload = {
            version: 52, // Bumping version to force update
            user_id: user.user_id,
            generated_at: Math.floor(DateTime.now().toSeconds()),
            settings: {
                fetch_time: nextFetchUtcStr, // SEND UTC TIME TO DEVICE
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
