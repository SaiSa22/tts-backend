import os
import boto3
import uuid
import requests

def main(args):
    # 1. Extract Text
    text = args.get("text", "Hello World")

    # 2. Define headers (Only Content-Type)
    response_headers = {
        "Content-Type": "application/json"
    }

    try:
        # Get Environment Variables
        speech_key = os.getenv("AZURE_SPEECH_KEY")
        service_region = os.getenv("AZURE_SPEECH_REGION")
        spaces_key = os.getenv("SPACES_KEY")
        spaces_secret = os.getenv("SPACES_SECRET")
        spaces_region = os.getenv("SPACES_REGION")
        bucket_name = os.getenv("SPACES_BUCKET")

        # 3. Call Azure Speech via REST API
        azure_url = f"https://{service_region}.tts.speech.microsoft.com/cognitiveservices/v1"

        azure_headers = {
            "Ocp-Apim-Subscription-Key": speech_key,
            "Content-Type": "application/ssml+xml",
            "X-Microsoft-OutputFormat": "audio-16khz-64kbitrate-mono-mp3",
            "User-Agent": "DO-Serverless"
        }

        ssml_body = f"""
        <speak version='1.0' xml:lang='en-US'>
            <voice xml:lang='en-US' xml:gender='Female' name='en-US-JennyNeural'>
                {text}
            </voice>
        </speak>
        """

        response = requests.post(azure_url, headers=azure_headers, data=ssml_body)

        if response.status_code != 200:
            return {
                "body": {"error": f"Azure Error: {response.text}"},
                "headers": response_headers,
                "statusCode": 400
            }

        audio_data = response.content

        # 4. Upload to DigitalOcean Spaces
        session = boto3.session.Session()
        client = session.client('s3',
                                region_name=spaces_region,
                                endpoint_url=f'https://{spaces_region}.digitaloceanspaces.com',
                                aws_access_key_id=spaces_key,
                                aws_secret_access_key=spaces_secret)

        filename = f"audio-{uuid.uuid4()}.mp3"

        client.put_object(Bucket=bucket_name, 
                          Key=filename, 
                          Body=audio_data, 
                          ACL='public-read', 
                          ContentType='audio/mpeg')

        # 5. Return Success URL
        file_url = f"https://{bucket_name}.{spaces_region}.digitaloceanspaces.com/{filename}"

        return {
            "body": {"url": file_url},
            "headers": response_headers,
            "statusCode": 200
        }

    except Exception as e:
        return {
            "body": {"error": str(e)},
            "headers": response_headers,
            "statusCode": 500
        }
