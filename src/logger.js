const pino = require('pino');

const logger = pino({ level: 'error' }, process.stderr);

module.exports = logger;
