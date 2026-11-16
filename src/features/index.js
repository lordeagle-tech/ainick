'use strict';

const runtime = require('./runtime');
require('./community.js')(runtime);
require('./admin.js')(runtime);
require('./gameBundle.js')(runtime);
require('./media.js')(runtime);
require('./web.js')(runtime);
require('./agents.js')(runtime);
require('./ai.js')(runtime);
require('./integrations.js')(runtime);
require('./projects.js')(runtime);
require('./system.js')(runtime);
require('./storage.js')(runtime);
require('./usage.js')(runtime);
require('./optional.js')(runtime);

module.exports = runtime.createRegistry();
