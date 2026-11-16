const pino = require('pino');

// Keep the terminal quiet during normal operation and print only code-level errors.
const logger = pino({ level: 'error' }, process.stderr);

module.exports = logger;
