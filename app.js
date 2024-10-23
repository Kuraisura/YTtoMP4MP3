require('dotenv').config(); // Load environment variables from .env file
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const { v4: uuidv4 } = require('uuid');
const puppeteer = require('puppeteer'); 
const chromium = require('chrome-aws-lambda'); 
const { spawn } = require('child_process');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3'); 
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const crypto = require('crypto');

// Check for SESSION_SECRET in the .env file
if (!process.env.SESSION_SECRET) {
    const sessionSecret = crypto.randomBytes(32).toString('hex');
    console.log(`Generated SESSION_SECRET: ${sessionSecret}`);

    // Append the SESSION_SECRET to the .env file
    fs.appendFileSync('.env', `\nSESSION_SECRET=${sessionSecret}`, { flag: 'a' });
} else {
    console.log(`Using existing SESSION_SECRET: ${process.env.SESSION_SECRET}`);
}

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
app.use(require('express-session')({ secret: process.env.SESSION_SECRET, resave: true, saveUninitialized: true }));
app.use(passport.initialize());
app.use(passport.session());

app.get('/favicon.ico', (req, res) => res.status(204).end());

// Ensure downloads directory exists
const downloadsDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir);
}

// Initialize the S3 client with credentials from environment variables
const s3 = new S3Client({
    region: process.env.AWS_REGION || 'ap-southeast-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});

// Google OAuth setup
passport.serializeUser((user, done) => {
    done(null, user);
});

passport.deserializeUser((user, done) => {
    done(null, user);
});

// Configure the Google strategy for use by Passport
passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: process.env.GOOGLE_REDIRECT_URI,
}, (accessToken, refreshToken, profile, done) => {
    return done(null, profile);
}));

// Define route for Google authentication
app.get('/auth/google', passport.authenticate('google', {
    scope: [process.env.GOOGLE_OAUTH2_SCOPE]
}));

// Define the callback route
app.get('/auth/google/callback', passport.authenticate('google', { failureRedirect: '/' }), (req, res) => {
    // Successful authentication, redirect home or to another page
    res.redirect('/');
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

    res.render('index', { user: req.user }); // Pass user info to the view
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
                '--geo-bypass',
            ],
            executablePath: await chromium.executablePath,
            headless: true,
        });

        const page = await browser.newPage();

        // Set the user agent
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36');

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
        Key: key, 
        Body: fileBuffer,
    };

    try {
        const result = await s3.send(new PutObjectCommand(uploadParams));
        console.log('Upload Success', result);
        return `https://${bucketName}.s3.amazonaws.com/${key}`;
    } catch (error) {
        console.error('Error uploading to S3:', error);
        throw error;
    }
}

// Convert endpoint
const FFMPEG_PATH = 'ffmpeg'; 
app.post('/convert', async (req, res) => {
    const { url, format } = req.body;
    console.log('Request body:', req.body);

    if (!isValidYouTubeUrl(url)) {
        return res.status(400).json({ error: 'Not a valid YouTube link' });
    }

    try {
        const title = await getVideoTitle(url);
        const sanitizedTitle = sanitizeFileName(title);
        const uniqueIdentifier = Date.now();
        let downloadCommand;

        let s3Key;
        const cookiePath = path.join(__dirname, 'cookies.txt'); // Path to your cookies file
        if (format === 'audio') {
            s3Key = `${sanitizedTitle}-${uniqueIdentifier}.mp3`;
            downloadCommand = `yt-dlp -x --audio-format mp3 --geo-bypass --ffmpeg-location "${FFMPEG_PATH}" --cookies "${cookiePath}" --no-check-certificate -o - "${url}" --user-agent "Mozilla/5.0"`;
        } else {
            s3Key = `${sanitizedTitle}-${uniqueIdentifier}.mp4`;
            downloadCommand = `yt-dlp -f "bestvideo+bestaudio/best" --geo-bypass --ffmpeg-location "${FFMPEG_PATH}" --cookies "${cookiePath}" --no-check-certificate -o - "${url}" --user-agent "Mozilla/5.0"`;
        }

        console.log('Starting download...');

        const downloadProcess = spawn(downloadCommand, {
            shell: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let dataBuffer = [];

        downloadProcess.stdout.on('data', (data) => {
            dataBuffer.push(data);
        });

        downloadProcess.stderr.on('data', (data) => {
            console.error(`stderr: ${data}`);
        });

        downloadProcess.on('close', async (code) => {
            if (code !== 0) {
                console.error('Download process exited with code:', code);
                return res.status(500).json({ error: 'Download failed' });
            }

            console.log('Download finished, uploading to S3...');
            const fileBuffer = Buffer.concat(dataBuffer); 

            const bucketName = process.env.AWS_S3_BUCKET;
            console.log('Using S3 Bucket:', bucketName); 

            try {
                const s3Url = await uploadToS3(fileBuffer, bucketName, s3Key);

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
        console.error('Error while fetching video title or processing download:', error);
        return res.status(500).json({ error: 'Server error' });
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
