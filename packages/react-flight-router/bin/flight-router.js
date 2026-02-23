#!/usr/bin/env node

import { build } from '../dist/build/build-orchestrator.js';

const command = process.argv[2];

if (command === 'build') {
  const appRoot = process.cwd();
  build({ appRoot }).catch((err) => {
    console.error('Build failed:', err);
    process.exit(1);
  });
} else {
  console.log('Usage: flight-router <command>');
  console.log('');
  console.log('Commands:');
  console.log('  build    Build the app for production');
  process.exit(1);
}
