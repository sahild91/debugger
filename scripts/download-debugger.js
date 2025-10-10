#!/usr/bin/env node

const https = require('https');
const fs = require('fs');
const path = require('path');

const DOWNLOAD_URLS = {
  darwin: "https://storage.googleapis.com/port11/swd-debugger-mac_aarch64",
  win32: "https://storage.googleapis.com/port11/swd-debugger.exe",
  linux: "https://storage.googleapis.com/port11/swd-debugger-linux_x86_64",
};

const DEST_FILE_NAME = "swd-debugger";

function getDownloadUrl() {
  const platform = process.platform;
  if (!DOWNLOAD_URLS[platform]) {
    throw new Error(`Unsupported platform: ${platform}`);
  }
  return DOWNLOAD_URLS[platform];
}

function getDestPath() {
  const distDir = path.join(__dirname, '..', 'dist');
  const fileName = process.platform === 'win32' ? `${DEST_FILE_NAME}.exe` : DEST_FILE_NAME;
  return path.join(distDir, fileName);
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    console.log(`📥 Downloading from: ${url}`);
    console.log(`📁 Destination: ${dest}`);

    const file = fs.createWriteStream(dest);

    https.get(url, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        // Handle redirect
        file.close();
        fs.unlinkSync(dest);
        return downloadFile(response.headers.location, dest)
          .then(resolve)
          .catch(reject);
      }

      if (response.statusCode !== 200) {
        file.close();
        fs.unlinkSync(dest);
        reject(new Error(`Download failed with status code: ${response.statusCode}`));
        return;
      }

      const totalBytes = parseInt(response.headers['content-length'], 10);
      let downloadedBytes = 0;
      let lastPercent = 0;

      response.on('data', (chunk) => {
        downloadedBytes += chunk.length;
        const percent = Math.floor((downloadedBytes / totalBytes) * 100);
        if (percent !== lastPercent && percent % 10 === 0) {
          console.log(`   Progress: ${percent}%`);
          lastPercent = percent;
        }
      });

      response.pipe(file);

      file.on('finish', () => {
        file.close();
        console.log('✅ Download complete');
        resolve();
      });

      file.on('error', (err) => {
        file.close();
        fs.unlinkSync(dest);
        reject(err);
      });
    }).on('error', (err) => {
      file.close();
      if (fs.existsSync(dest)) {
        fs.unlinkSync(dest);
      }
      reject(err);
    });
  });
}

async function main() {
  try {
    console.log('🚀 Starting swd-debugger download...');
    console.log(`   Platform: ${process.platform}`);

    // Ensure dist directory exists
    const distDir = path.join(__dirname, '..', 'dist');
    if (!fs.existsSync(distDir)) {
      console.log('📁 Creating dist directory...');
      fs.mkdirSync(distDir, { recursive: true });
    }

    const destPath = getDestPath();
    const downloadUrl = getDownloadUrl();

    // Check if already exists
    if (fs.existsSync(destPath)) {
      console.log('⚠️  swd-debugger already exists, removing old version...');
      fs.unlinkSync(destPath);
    }

    // Download
    await downloadFile(downloadUrl, destPath);

    // Make executable on Unix-like systems
    if (process.platform !== 'win32') {
      console.log('🔧 Setting executable permissions...');
      fs.chmodSync(destPath, '755');
    }

    // Verify
    const stats = fs.statSync(destPath);
    console.log(`✅ Installation successful!`);
    console.log(`   File size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
    console.log(`   Location: ${destPath}`);

  } catch (error) {
    console.error('❌ Failed to download swd-debugger:', error.message);
    process.exit(1);
  }
}

main();
