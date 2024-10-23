const fs = require('fs');
const path = require('path');

// Function to initialize file system for downloads and cookies
function initializeFileSystem() {
    const downloadsDir = path.join(__dirname, 'downloads');
    if (!fs.existsSync(downloadsDir)) {
        fs.mkdirSync(downloadsDir);
    }

    const cookiesFilePath = path.join(__dirname, 'cookies.txt');
    if (!fs.existsSync(cookiesFilePath)) {
        fs.writeFileSync(cookiesFilePath, '');
    }
}

module.exports = { initializeFileSystem };
