const fs = require('fs');
const path = require('path');
const output = path.join(__dirname, '..', 'dist');
fs.rmSync(output, { recursive: true, force: true });
