#!/usr/bin/env node
import { planCieCutover } from './ao/lib/cie-cutover.js';
const [configPath,sessionsDir] = process.argv.slice(2);
if (!configPath || !sessionsDir) throw new Error('Usage: node scripts/cie-cutover-plan.js <legacy-config.yaml> <sessions-dir>');
console.log(JSON.stringify(planCieCutover({configPath,sessionsDir}),null,2));
