# download.py
import sys
import subprocess

def download_video(url, output_format):
    try:
        if output_format == 'audio':
            command = [
                'yt-dlp', '-x', '--audio-format', 'mp3', '-o', '%(title)s.%(ext)s', url
            ]
        else:
            command = [
                'yt-dlp', '-f', 'bestvideo+bestaudio/best', '-o', '%(title)s.webm', url
            ]

        result = subprocess.run(command, capture_output=True, text=True)
        if result.returncode != 0:
            print(result.stderr)
            return {'error': 'Download failed'}
        
        return {'success': True, 'stdout': result.stdout.strip()}
    except Exception as e:
        print(str(e))
        return {'error': str(e)}

if __name__ == "__main__":
    url = sys.argv[1]
    format_type = sys.argv[2]
    response = download_video(url, format_type)
    print(response)
