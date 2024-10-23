const fs = require('fs');
const path = require('path');

// Path to your app.js file
const appFilePath = path.join(__dirname, 'app.js');

// Read the content of app.js
fs.readFile(appFilePath, 'utf8', (err, data) => {
    if (err) {
        console.error('Error reading app.js:', err);
        return;
    }

    // Regular expression to find the command construction part in the convert endpoint
    const regex = /(?:let downloadCommand;[\s\S]*?)(if \(format === 'audio'\) \{[\s\S]*?})/;

    // Check if the regex matches the expected structure
    if (!regex.test(data)) {
        console.error('Could not find the download command section in app.js');
        return;
    }

    // Check if the modifications already exist
    if (data.includes('const cookiesOption = `--cookies')) {
        console.log('The modification for cookiesOption already exists. No changes made.');
        return;
    }

    // Modify the command construction
    const modifiedData = data.replace(regex, (match, p1) => {
        // Add the cookies option
        const cookiesOption = `const cookiesOption = \`--cookies "\${cookiesFilePath}"\`;\n`;

        // Construct the new download command string
        const newCommand = `
            ${cookiesOption}
            if (format === 'audio') {
                downloadCommand = \`yt-dlp -x --audio-format mp3 --ffmpeg-location "\${FFMPEG_PATH}" -o "\${outputPath}" \${cookiesOption} "\${url}"\`;
            } else {
                downloadCommand = \`yt-dlp -f "bestvideo+bestaudio/best" --ffmpeg-location "\${FFMPEG_PATH}" -o "\${webmPath}" \${cookiesOption} "\${url}"\`;
            }
        `;

        return `${match.replace(p1, newCommand)}`;
    });

    // Write the modified content back to app.js
    fs.writeFile(appFilePath, modifiedData, 'utf8', (err) => {
        if (err) {
            console.error('Error writing to app.js:', err);
            return;
        }

        console.log('app.js has been successfully updated with the cookies option.');
    });
});
