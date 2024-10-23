require('dotenv').config(); // Load environment variables from .env file
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs'); // Single import for fs
const cors = require('cors');
const cookieParser = require('cookie-parser');
const { v4: uuidv4 } = require('uuid');
const puppeteer = require('puppeteer'); // Change this to puppeteer
const chromium = require('chrome-aws-lambda'); // Import chrome-aws-lambda
const { spawn } = require('child_process'); // Changed from exec to spawn
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3'); // AWS SDK v3
const app = express();
const PORT = process.env.PORT || 3000;

// Set the view engine and views directory
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(cookieParser());
app.use(express.static('public'));
app.get('/favicon.ico', (req, res) => res.status(204).end());

// Ensure downloads directory exists
const downloadsDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir);
}

// Initialize the S3 client with credentials from environment variables (AWS SDK v3)
const s3 = new S3Client({
    region: process.env.AWS_REGION || 'ap-southeast-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});

// Root route
app.get('/', (req, res) => {
    const userCookie = req.cookies.user;
    let userId;

    if (!userCookie) {
        userId = uuidv4();
        res.cookie('user', userId, { maxAge: 7 * 24 * 60 * 60 * 1000, httpOnly: true });
        console.log(`Set cookie: user=${userId}`);
    } else {
        userId = userCookie;
        console.log(`Accessed cookie: user=${userId}`);
    }

    res.render('index');
});

// Validate YouTube URL
function isValidYouTubeUrl(url) {
    const regex = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+/;
    return regex.test(url);
}

// Extract video ID from URL
function getVideoId(url) {
    const regex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:[^\/\n\s]+\/\S+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^&\n]{11})/;
    const match = url.match(regex);
    return match ? match[1] : null;
}

async function getVideoTitle(url) {
    let browser = null;
    try {
        // Launch Puppeteer with chrome-aws-lambda
        browser = await puppeteer.launch({
            args: [
                ...chromium.args,
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--geo-bypass', // Add geo-bypass option
            ],
            executablePath: await chromium.executablePath,
            headless: true,
        });

        const page = await browser.newPage();

        // Set the user agent
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36');

        // Set cookies for authentication
        const cookies = [
            {
                name: 'YSC',
                value: 'NMch3UzERTk',
                domain: '.youtube.com',
                path: '/',
                httpOnly: true,
                secure: true,
            },
            {
                name: 'VISITOR_INFO1_LIVE',
                value: 'bm71uRCtw34',
                domain: '.youtube.com',
                path: '/',
                httpOnly: true,
                secure: true,
            },
            {
                name: 'LOGIN_INFO',
                value: 'AFmmF2swRQIhALevMn5RJQqazchB1luxOiDDX4PBnuI2WMkr_k84uKfvAiBjU_rO43iKhgfgjsR831zrBULub06aeHs55hFGfkOAAA:QUQ3MjNmeDZjSGhyUy0wWFJtZnRmTXFuLXZQbzVEMnZycFlOUzIxYWpYb1N4bGNHOTBWV0FTRkY0SGMwUklwQk5OdzJKWXdXUWtZUTNDSGF0a3VrNU11N1BIelVvWlc3V2FyS3Y4TWlzZTVaYzdkbnpzXzNUMXk5enV6U1p2aXNib2x5NkV6M0QtN1FmaUpQelQ1eURrR0F3MFRZN0dJTUl3',
                domain: '.youtube.com',
                path: '/',
                httpOnly: true,
                secure: true,
            }
        ];

        // Set cookies on the page
        await page.setCookie(...cookies);

        await page.goto(url, { waitUntil: 'networkidle2' });
        const title = await page.title();
        return title;
    } catch (error) {
        console.error('Error while fetching video title:', error);
        throw error;
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}



// Sanitize file name
function sanitizeFileName(fileName) {
    return fileName.replace(/[<>:"/\\|?*]+/g, '_').trim();
}

// Function to upload file to S3
async function uploadToS3(fileBuffer, bucketName, key) {
    const uploadParams = {
        Bucket: bucketName,
        Key: key, // This is the name you want to give the file in S3
        Body: fileBuffer,
    };

    try {
        const result = await s3.send(new PutObjectCommand(uploadParams));
        console.log('Upload Success', result);
        return `https://${bucketName}.s3.amazonaws.com/${key}`; // Return the S3 URL
    } catch (error) {
        console.error('Error uploading to S3:', error);
        throw error;
    }
}

// Convert endpoint
const FFMPEG_PATH = 'ffmpeg'; // Update this if necessary
app.post('/convert', async (req, res) => {
    const { url, format } = req.body;
    console.log('Request body:', req.body);

    // Validate YouTube URL
    if (!isValidYouTubeUrl(url)) {
        return res.status(400).json({ error: 'Not a valid YouTube link' });
    }

    try {
        const title = await getVideoTitle(url);
        const sanitizedTitle = sanitizeFileName(title);
        const uniqueIdentifier = Date.now();
        let downloadCommand;

        // Setup download command based on format
        let s3Key;
        if (format === 'audio') {
            s3Key = `${sanitizedTitle}-${uniqueIdentifier}.mp3`;
            downloadCommand = `yt-dlp -x --audio-format mp3 --geo-bypass --ffmpeg-location "${FFMPEG_PATH}" --no-check-certificate -o - "${url}" --user-agent "Your User Agent"`;
        } else {
            s3Key = `${sanitizedTitle}-${uniqueIdentifier}.mp4`;
            downloadCommand = `yt-dlp -f "bestvideo+bestaudio/best" --geo-bypass --ffmpeg-location "${FFMPEG_PATH}" --no-check-certificate -o - "${url}" --user-agent "Your User Agent"`;
        }

        console.log('Starting download...');

        // Use spawn to execute the command
        const downloadProcess = spawn(downloadCommand, {
            shell: true,
            stdio: ['ignore', 'pipe', 'pipe'], // Ignore stdin, capture stdout and stderr
        });

        let dataBuffer = [];

        // Collect data from stdout
        downloadProcess.stdout.on('data', (data) => {
            dataBuffer.push(data);
        });

        // Handle errors
        downloadProcess.stderr.on('data', (data) => {
            console.error(`stderr: ${data}`);
        });

        // When the process completes
        downloadProcess.on('close', async (code) => {
            if (code !== 0) {
                console.error('Download process exited with code:', code);
                return res.status(500).json({ error: 'Download failed' });
            }

            console.log('Download finished, uploading to S3...');
            const fileBuffer = Buffer.concat(dataBuffer); // Combine all data chunks

            // Log the bucket name for debugging
            const bucketName = process.env.AWS_S3_BUCKET;
            console.log('Using S3 Bucket:', bucketName); // Log the bucket name

            // Upload to S3
            try {
                const s3Url = await uploadToS3(fileBuffer, bucketName, s3Key);

                // Return the S3 URL
                return res.json({
                    downloadUrl: s3Url,
                    title: sanitizedTitle,
                    thumbnailUrl: `https://img.youtube.com/vi/${getVideoId(url)}/maxresdefault.jpg?t=${Date.now()}`,
                });
            } catch (uploadError) {
                console.error('Error uploading to S3:', uploadError);
                return res.status(500).json({ error: 'Failed to upload to S3' });
            }
        });
    } catch (error) {
        console.error('Error while fetching video title or processing:', error);
        res.status(500).json({ error: 'Could not fetch video' });
    }
});

// Serve downloads
app.use('/downloads', express.static(downloadsDir));

// Function to delete old video files
function deleteOldFiles() {
    fs.readdir(downloadsDir, (err, files) => {
        if (err) {
            console.error('Error reading downloads directory:', err);
            return;
        }

        files.forEach(file => {
            const filePath = path.join(downloadsDir, file);
            if (file.endsWith('.mp4') || file.endsWith('.mp3')) {
                fs.unlink(filePath, (err) => {
                    if (err) {
                        console.error(`Error deleting file: ${file}`, err);
                    } else {
                        console.log(`Deleted file: ${file}`);
                    }
                });
            }
        });
    });
}

// Run this every hour to clean up old files
setInterval(deleteOldFiles, 3600000);

// Start server
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
