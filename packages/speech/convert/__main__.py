import os
import boto3
import uuid
import requests
import json

def main(args):
    # 1. Extract Text
    text = args.get("text", "Hello World")
    
    # Default to Jenny if no voice is chosen
    selected_voice = args.get("voice", "en-US-JennyNeural") 
    
    # 2. Define headers
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
            <voice xml:lang='en-US' xml:gender='Female' name='{selected_voice}'>
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

        # 4. Setup Boto3 Client (S3 Connection)
        session = boto3.session.Session()
        client = session.client('s3',
                                region_name=spaces_region,
                                endpoint_url=f'https://{spaces_region}.digitaloceanspaces.com',
                                aws_access_key_id=spaces_key,
                                aws_secret_access_key=spaces_secret)

        # ---------------------------------------------------------
        # CRITICAL FIX: Ensure UUID is in the filename
        # ---------------------------------------------------------
        filename = f"daily_audio-{uuid.uuid4()}.mp3"
        
        # Upload the Audio File
        client.put_object(Bucket=bucket_name, 
                          Key=filename, 
                          Body=audio_data, 
                          ACL='public-read', 
                          ContentType='audio/mpeg')

        # Create the public URL
        file_url = f"https://{bucket_name}.{spaces_region}.digitaloceanspaces.com/{filename}"

        # ---------------------------------------------------------
        # UPDATE STATUS.JSON
        # ---------------------------------------------------------
        status_filename = "status.json"
        
        try:
            # Download existing status.json
            s3_response = client.get_object(Bucket=bucket_name, Key=status_filename)
            file_content = s3_response['Body'].read().decode('utf-8')
            status_data = json.loads(file_content)
        except Exception:
            # If file doesn't exist, start fresh
            status_data = {"version": 0, "audio_url": ""}

        # Update Version and URL
        current_version = status_data.get("version", 0)
        status_data["version"] = current_version + 1
        status_data["audio_url"] = file_url  # This will now contain the UUID

        # Save status.json back to Spaces
        client.put_object(Bucket=bucket_name, 
                          Key=status_filename, 
                          Body=json.dumps(status_data, indent=2), 
                          ACL='public-read', 
                          ContentType='application/json')

        # 5. Return Success
        return {
            "body": {"url": file_url, "version": status_data["version"]},
            "headers": response_headers,
            "statusCode": 200
        }

    except Exception as e:
        return {
            "body": {"error": str(e)},
            "headers": response_headers,
            "statusCode": 500
        }
