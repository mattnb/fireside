#!/usr/bin/env node
const path = require('node:path');

process.env.FIRESIDE_UI_DIR = path.resolve(process.cwd(), 'dist/client/browser');

import('../dist/server/src/index.js')
  .then(({ main }) => main())
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
