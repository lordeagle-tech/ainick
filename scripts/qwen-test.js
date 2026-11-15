const { qwenChat } = require('../src/features/scrapers');

(async () => {
  const prompt = process.argv.slice(2).join(' ') || 'Reply with exactly: QWEN OK';
  try {
    const result = await qwenChat(prompt);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
})();
