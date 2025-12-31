const { createClient } = require('@supabase/supabase-js');
const sdk = require("microsoft-cognitiveservices-speech-sdk");
const AWS = require('aws-sdk');

// Initialize Clients
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const spaces = new AWS.S3({
    endpoint: new AWS.Endpoint(process.env.SPACES_ENDPOINT),
    accessKeyId: process.env.SPACES_KEY,
    secretAccessKey: process.env.SPACES_SECRET
});

async function main(args) {
    const now = new Date();
    const currentHour = now.getUTCHours(); 

    // 1. Get Users scheduling for this hour
    // Note: In production, you might need better timezone math (e.g. luxon)
    // For now, we compare the simple "HH" string from settings to the current UTC hour
    const { data: users } = await supabase
        .from('user_settings')
        .select('user_id, fetch_time, timezone');
    
    // Filter: If user set "14:00", we run when UTC hour is 14.
    const activeUsers = users.filter(u => parseInt(u.fetch_time.split(':')[0]) === currentHour);
    
    const results = [];

    // 2. Process each User
    for (const user of activeUsers) {
        const todayStr = new Date().toISOString().split('T')[0];
        
        // Fetch up to 3 events for today
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

            // A. Generate Audio ONLY if not already processed
            if (!event.processed) {
                try {
                    const audioBuffer = await generateAzureAudio(event.message);
                    
                    // Filename: [USER_ID]_[SEQUENCE].mp3
                    const mp3Filename = `${user.user_id}_0${seq}.mp3`;

                    // Upload MP3 to Spaces
                    await spaces.putObject({
                        Bucket: process.env.SPACES_BUCKET,
                        Key: mp3Filename,
                        Body: audioBuffer,
                        ACL: 'public-read',
                        ContentType: 'audio/mpeg'
                    }).promise();

                    publicUrl = `https://${process.env.SPACES_BUCKET}.${process.env.SPACES_ENDPOINT}/${mp3Filename}`;

                    // Update DB so we don't regenerate next time
                    await supabase
                        .from('events')
                        .update({ audio_url: publicUrl, processed: true })
                        .eq('id', event.id);

                } catch (err) {
                    console.error(`Error processing event ${event.id}:`, err);
                    continue; // Skip this event if audio generation fails
                }
            }

            // B. Prepare Data for Manifest
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

        // C. Generate JSON Manifest
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

        // D. Upload JSON to Spaces
        const jsonFilename = `${user.user_id}_status.json`;
        await spaces.putObject({
            Bucket: process.env.SPACES_BUCKET,
            Key: jsonFilename,
            Body: JSON.stringify(manifestPayload),
            ACL: 'public-read',
            ContentType: 'application/json',
            CacheControl: 'max-age=60' // Prevent caching so device gets fresh data
        }).promise();

        results.push({ user: user.user_id, manifest: jsonFilename });
    }

    return { body: { processed: results.length, details: results } };
}

// Helper: Azure Logic
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
