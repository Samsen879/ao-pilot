#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLegacyReleaseDeploy } from './ao/lib/legacy-release-deploy.js';
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = (await runLegacyReleaseDeploy(process.argv.slice(2))).exitCode;
}
