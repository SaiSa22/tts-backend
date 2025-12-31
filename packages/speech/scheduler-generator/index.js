const { createClient } = require('@supabase/supabase-js');
const sdk = require("microsoft-cognitiveservices-speech-sdk");
const AWS = require('aws-sdk');

// We do NOT initialize clients here anymore to prevent startup crashes.

async function main(args) {
    console.log("Function started. Checking environment variables...");

    // 1. Safe Initialization & Debugging
    const sbUrl = process.env.SUPABASE_URL;
    const sbKey = process.env.SUPABASE_KEY;
    
    if (!sbUrl || !sbKey) {
        console.error("CRITICAL ERROR: Missing SUPABASE_URL or SUPABASE_KEY.");
        return { body: { error: "Configuration Error: Missing Supabase Secrets" } };
    }

    // Initialize Clients INSIDE the function
    const supabase = createClient(sbUrl, sbKey);
    
    // Check other vars
    if (!process.env.SPACES_ENDPOINT || !process.env.SPACES_KEY) {
        console.error("CRITICAL ERROR: Missing Spaces Configuration.");
        return { body: { error: "Configuration Error: Missing Spaces Secrets" } };
    }

    const spaces = new AWS.S3({
        endpoint: new AWS.Endpoint(process.env.SPACES_ENDPOINT),
        accessKeyId: process.env.SPACES_KEY,
        secretAccessKey: process.env.SPACES_SECRET
    });

    // 2. Logic Start
    const now = new Date();
    const currentHour = now.getUTCHours(); 
    console.log(`Current UTC Hour: ${currentHour}`);

    // Fetch users
    const { data: users, error: userError } = await supabase
        .from('user_settings')
        .select('user_id, fetch_time, timezone');
    
    if (userError) {
        console.error("Supabase Error:", userError);
        return { body: { error: userError.message } };
    }

    // Filter users (Simple check)
    // Ensure fetch_time exists to prevent crash on undefined
    const activeUsers = users.filter(u => u.fetch_time && parseInt(u.fetch_time.split(':')[0]) === currentHour);
    console.log(`Found ${activeUsers.length} active users for this hour.`);
    
    const results = [];

    // 3. Process Users
    for (const user of activeUsers) {
        const todayStr = new Date().toISOString().split('T')[0];
        
        const { data: events } = await supabase
            .from('events')
            .select('*')
            .eq('user_id', user.user_id)
            .eq('date', todayStr)
            .order('start_time', { ascending: true })
            .limit(3);

        if (!events || events.length === 0) continue;

        const manifestEvents = [];
        let seq = 1;

        for (const event of events) {
            let publicUrl = event.audio_url;

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

                    publicUrl = `https://${process.env.SPACES_BUCKET}.${process.env.SPACES_ENDPOINT}/${mp3Filename}`;

                    await supabase
                        .from('events')
                        .update({ audio_url: publicUrl, processed: true })
                        .eq('id', event.id);

                } catch (err) {
                    console.error(`Error processing event ${event.id}:`, err);
                    continue; 
                }
            }

            const startParts = event.start_time.split(':');
            const endParts = event.end_time.split(':');
            const startDate = new Date();
            startDate.setHours(parseInt(startParts[0]), parseInt(startParts[1]), 0, 0);
            const endDate = new Date();
            endDate.setHours(parseInt(endParts[0]), parseInt(endParts[1]), 0, 0);

            manifestEvents.push({
                sequence: seq,
                alertStart: Math.floor(startDate.getTime() / 1000),
                alertEnd: Math.floor(endDate.getTime() / 1000),
                audio_url: publicUrl
            });
            seq++;
        }

        const manifestPayload = {
            version: 51,
            user_id: user.user_id,
            generated_at: Math.floor(Date.now() / 1000),
            settings: {
                fetch_time: user.fetch_time,
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

        results.push({ user: user.user_id, manifest: jsonFilename });
    }

    return { body: { processed: results.length, details: results } };
}

function generateAzureAudio(text) {
    return new Promise((resolve, reject) => {
        const speechConfig = sdk.SpeechConfig.fromSubscription(process.env.AZURE_KEY, process.env.AZURE_REGION);
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
