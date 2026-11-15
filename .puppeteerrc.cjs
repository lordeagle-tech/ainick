/** @type {import('puppeteer').Configuration} */
module.exports = {
  // Pterodactyl containers may not have unzip or permission to install
  // Chrome-for-Testing during npm install. Keep Puppeteer optional at boot;
  // browser features can use CHROME_EXECUTABLE_PATH/PUPPETEER_EXECUTABLE_PATH
  // when a system Chrome/Chromium is available.
  skipDownload: true,
};
