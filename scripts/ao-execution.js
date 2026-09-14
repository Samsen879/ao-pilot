#!/usr/bin/env node
import { createSupervisedExecution } from './ao/lib/supervised-execution.js';
export async function runCli(argv = process.argv.slice(2), io = {
  writeStdout: text => process.stdout.write(text),
  writeStderr: text => process.stderr.write(text)
}) {
  const help = 'Usage: ao-pilot execution inspect --store <persistent-directory> --invocation <id>\nEnrolled run/rerun requires the trusted-host ao-pilot/execution API and verified Owner ledger; no unsigned CLI launch.\n';
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) {
    io.writeStdout(help);
    return {
      exitCode: 0,
      result: null
    };
  }
  try {
    if (argv[0] !== 'inspect' || argv.length !== 5) throw new Error('Trusted-host API required for launch; HOLD');
    const options = {};
    for (let i = 1; i < argv.length; i += 2) {
      if (!['--store', '--invocation'].includes(argv[i]) || options[argv[i]]) throw new Error('Invalid execution inspect options; HOLD');
      options[argv[i]] = argv[i + 1];
    }
    if (!options['--store'] || !options['--invocation']) throw new Error('Exact store and invocation required; HOLD');
    const observation = await createSupervisedExecution({
      directory: options['--store']
    }).inspect(options['--invocation']);
    const {
      record,
      ...report
    } = observation;
    io.writeStdout(JSON.stringify({
      schema_version: 'ao.execution-observation.v1',
      ...report
    }, null, 2) + '\n');
    return {
      exitCode: report.evidence_status === 'established' ? 0 : 2,
      result: report
    };
  } catch {
    io.writeStderr('Execution custody cannot be established; HOLD\n');
    return {
      exitCode: 2,
      result: null
    };
  }
}
