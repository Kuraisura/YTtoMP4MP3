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
const { S3Client, PutObjectCommand, ListObjectsCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3'); // AWS SDK v3
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

// Ensure oauth_config.json file exists for storing the OAuth token
const oauthConfigPath = path.join(__dirname, 'oauth_config.json');
let oauthToken = null;

// Load OAuth token from file if it exists
if (fs.existsSync(oauthConfigPath)) {
    const oauthConfig = JSON.parse(fs.readFileSync(oauthConfigPath, 'utf8'));
    oauthToken = oauthConfig.access_token; // Use the access token directly
}

// Define cookies file path
const cookiesFilePath = path.join(__dirname, 'cookies.txt');

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
        fs.appendFileSync(cookiesFilePath, `Set cookie: user=${userId}\n`, 'utf8');
    } else {
        userId = userCookie;
        console.log(`Accessed cookie: user=${userId}`);
    }

    res.render('index');
});


// Endpoint to read the cookie
app.get('/get-cookie', (req, res) => {
    const userCookie = req.cookies.user;
    if (userCookie) {
        console.log(`Accessed cookie: user=${userCookie}`);
        res.send(`User cookie value: ${userCookie}`);
    } else {
        res.send('No user cookie found.');
    }
});

// Endpoint to delete the cookie
app.get('/delete-cookie', (req, res) => {
    res.clearCookie('user');
    console.log('Deleted cookie: user');
    res.send('User cookie has been deleted.');
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
                '--disable-setuid-sandbox'
            ],
            executablePath: await chromium.executablePath,
            headless: true,
        });
        
        const page = await browser.newPage();
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
            downloadCommand = `yt-dlp -x --audio-format mp3 --ffmpeg-location "${FFMPEG_PATH}" --no-check-certificate --username "oauth" --password "${oauthToken}" -o - "${url}"`; // Use - to output to stdout
        } else {
            s3Key = `${sanitizedTitle}-${uniqueIdentifier}.mp4`;
            downloadCommand = `yt-dlp -f "bestvideo+bestaudio/best" --ffmpeg-location "${FFMPEG_PATH}" --no-check-certificate --username "oauth" --password "${oauthToken}" -o - "${url}"`; // Use - to output to stdout
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
            if (file.endsWith('.mp3') || file.endsWith('.mp4')) {
                fs.unlink(filePath, (err) => {
                    if (err) {
                        console.error(`Error deleting file ${filePath}:`, err);
                    } else {
                        console.log(`Deleted file: ${filePath}`);
                    }
                });
            }
        });
    });
}

// Function to delete all objects in the S3 bucket
async function deleteAllS3Objects() {
    const bucketName = process.env.AWS_S3_BUCKET;
    console.log('Deleting all objects in S3 bucket:', bucketName);

    try {
        const listCommand = new ListObjectsCommand({ Bucket: bucketName });
        const { Contents } = await s3.send(listCommand);

        if (Contents.length > 0) {
            const deletePromises = Contents.map(async (object) => {
                const deleteCommand = new DeleteObjectCommand({
                    Bucket: bucketName,
                    Key: object.Key,
                });
                await s3.send(deleteCommand);
                console.log(`Deleted S3 object: ${object.Key}`);
            });

            await Promise.all(deletePromises);
        } else {
            console.log('No objects found in S3 bucket.');
        }
    } catch (error) {
        console.error('Error deleting S3 objects:', error);
    }
}

// Schedule the S3 delete operation every hour
setInterval(deleteAllS3Objects, 60 * 60 * 1000); // 60 minutes * 60 seconds * 1000 milliseconds

// Start the server
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    deleteOldFiles(); // Optionally call this on startup to clean up
});
