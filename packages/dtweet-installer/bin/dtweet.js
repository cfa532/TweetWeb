#!/usr/bin/env node
import { main } from '../lib/install.js';

main(process.argv.slice(2)).catch(error => {
  console.error(`dTweet installer stopped: ${error.message}`);
  process.exitCode = 1;
});
