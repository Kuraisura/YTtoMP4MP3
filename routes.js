const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const puppeteer = require('puppeteer-core');

const cookiesFilePath = path.join(__dirname, 'cookies.txt');
const downloadsDir = path.join(__dirname, 'downloads');

function setupRoutes(app) {
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
            fs.appendFileSync(cookiesFilePath, `Accessed cookie: user=${userId}\n`, 'utf8');
        }

        res.render('index');
    });

    // Route to get the user cookie
    app.get('/get-cookie', (req, res) => {
        const userCookie = req.cookies.user;
        if (userCookie) {
            fs.appendFileSync(cookiesFilePath, `Accessed cookie: user=${userCookie}\n`, 'utf8');
            res.send(`User cookie value: ${userCookie}`);
        } else {
            res.send('No user cookie found.');
        }
    });

    // Route to delete the user cookie
    app.get('/delete-cookie', (req, res) => {
        res.clearCookie('user');
        fs.appendFileSync(cookiesFilePath, `Deleted cookie: user\n`, 'utf8');
        res.send('User cookie has been deleted.');
    });

    // Convert endpoint (already detailed in previous messages)
    app.post('/convert', async (req, res) => {
        const { url, format } = req.body;
        console.log('Request body:', req.body);

        // Validate YouTube URL
        if (!isValidYouTubeUrl(url)) {
            return res.status(400).json({ error: 'Not a valid YouTube link' });
        }

        try {
            const title = await getVideoTitle(url); // Now using Puppeteer
            const sanitizedTitle = sanitizeFileName(title);
            const uniqueIdentifier = Date.now();
            let outputPath;

            if (format === 'audio') {
                outputPath = path.join(downloadsDir, `${sanitizedTitle}-${uniqueIdentifier}.mp3`);
            } else {
                outputPath = path.join(downloadsDir, `${sanitizedTitle}-${uniqueIdentifier}.mp4`);
            }

            console.log('Output path:', outputPath);

            // Include cookies option in the download command
            const cookiesOption = `--cookies "${cookiesFilePath}"`;
            let downloadCommand;

            // Construct the download command based on the format
            if (format === 'audio') {
                downloadCommand = `yt-dlp -x --audio-format mp3 --ffmpeg-location "${FFMPEG_PATH}" -o "${outputPath}" ${cookiesOption} "${url}"`;
            } else {
                downloadCommand = `yt-dlp -f "bestvideo+bestaudio/best" --ffmpeg-location "${FFMPEG_PATH}" -o "${outputPath}" ${cookiesOption} "${url}"`;
            }

            exec(downloadCommand, (error, stdout, stderr) => {
                if (error) {
                    console.error('Error during download:', error);
                    console.error('stderr:', stderr);
                    return res.status(500).json({ error: 'Download failed' });
                }
                console.log('Download finished:', stdout);
                return res.json({
                    downloadUrl: `/downloads/${encodeURIComponent(sanitizedTitle + '-' + uniqueIdentifier + (format === 'audio' ? '.mp3' : '.mp4'))}`,
                    title: sanitizedTitle
                });
            });
        } catch (error) {
            console.error('Error while fetching video title or processing:', error);
            res.status(500).json({ error: 'Could not fetch video' });
        }
    });
}

// Function to validate YouTube URL
function isValidYouTubeUrl(url) {
    const regex = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+/;
    return regex.test(url);
}

// Function to get video title using Puppeteer
async function getVideoTitle(url) {
    const browser = await puppeteer.launch({
        executablePath: process.env.CHROME_BIN || '/app/.apt/usr/bin/google-chrome', // Specify Chrome executable path
        headless: true, // Run in headless mode
        args: ['--no-sandbox', '--disable-setuid-sandbox'] // Required for Heroku
    });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle2' });

    // Wait for the title element to be loaded
    const title = await page.title();
    
    await browser.close(); // Close the browser instance
    return title;
}

// Sanitize file name
function sanitizeFileName(fileName) {
    return fileName.replace(/[<>:"/\\|?*]+/g, '_').trim();
}

module.exports = { setupRoutes };
