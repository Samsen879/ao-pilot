#!/usr/bin/env node

import {
  closeRelayGroup,
  createSamePortRelayMappings,
  startRelayGroup,
} from './lib/windows-localhost-relay.js';

function printUsage() {
  console.error(
    'Usage: node scripts/ao/windows-localhost-relay.js --target-host <host> --ports <p1,p2,...> [--listen-host <host>]',
  );
}

function parseArgs(argv) {
  const args = {
    listenHost: '127.0.0.1',
    targetHost: null,
    ports: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--listen-host') {
      args.listenHost = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (arg === '--target-host') {
      args.targetHost = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (arg === '--ports') {
      args.ports = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (arg === '-h' || arg === '--help') {
      args.help = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function parsePorts(value) {
  if (!value) {
    throw new Error('--ports is required');
  }

  const ports = value
    .split(',')
    .map((part) => Number.parseInt(part.trim(), 10));

  if (ports.some((port) => Number.isNaN(port) || port < 0 || port > 65535)) {
    throw new Error(`Invalid --ports value: ${value}`);
  }

  return ports;
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    printUsage();
    process.exit(0);
  }

  if (!parsed.targetHost) {
    throw new Error('--target-host is required');
  }

  const mappings = createSamePortRelayMappings({
    listenHost: parsed.listenHost,
    targetHost: parsed.targetHost,
    ports: parsePorts(parsed.ports),
  });

  const relayGroup = await startRelayGroup(mappings, {
    logger: console,
  });

  const shutdown = async (signal) => {
    console.log(`shutting down relay on ${signal}`);
    await closeRelayGroup(relayGroup);
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  console.log(
    mappings
      .map((mapping) => (
        `READY ${mapping.listenHost}:${mapping.listenPort} -> ${mapping.targetHost}:${mapping.targetPort}`
      ))
      .join('\n'),
  );

  await new Promise(() => {});
}

main().catch((error) => {
  printUsage();
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
