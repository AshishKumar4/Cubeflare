#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { runCli } from '../public/downloads/cubeflare';

export { createActivityReporter } from '../public/downloads/cubeflare';

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  runCli();
}
