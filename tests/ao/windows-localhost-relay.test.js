import net from 'node:net';

import { afterEach, describe, expect, it } from '@jest/globals';

import {
  closeRelayGroup,
  createSamePortRelayMappings,
  startRelayGroup,
} from '../../scripts/ao/lib/windows-localhost-relay.js';

const serversToClose = [];

function listen(server, host = '127.0.0.1', port = 0) {
  return new Promise((resolve, reject) => {
    server.listen(port, host, () => {
      serversToClose.push(server);
      resolve(server.address());
    });
    server.once('error', reject);
  });
}

function connect(port, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port }, () => resolve(socket));
    socket.once('error', reject);
  });
}

afterEach(async () => {
  while (serversToClose.length) {
    const server = serversToClose.pop();
    await new Promise((resolve) => server.close(() => resolve()));
  }
});

describe('windows localhost relay', () => {
  it('builds same-port relay mappings for a WSL target host', () => {
    expect(createSamePortRelayMappings({
      targetHost: '172.30.25.37',
      ports: [3310, 14810, 14811],
    })).toEqual([
      {
        listenHost: '127.0.0.1',
        listenPort: 3310,
        targetHost: '172.30.25.37',
        targetPort: 3310,
      },
      {
        listenHost: '127.0.0.1',
        listenPort: 14810,
        targetHost: '172.30.25.37',
        targetPort: 14810,
      },
      {
        listenHost: '127.0.0.1',
        listenPort: 14811,
        targetHost: '172.30.25.37',
        targetPort: 14811,
      },
    ]);
  });

  it('forwards bidirectional TCP traffic to the target port', async () => {
    const upstreamServer = net.createServer((socket) => {
      socket.on('data', (chunk) => {
        socket.write(Buffer.from(String(chunk).toUpperCase()));
      });
    });
    const upstreamAddress = await listen(upstreamServer);

    const [{ listenPort }] = createSamePortRelayMappings({
      targetHost: upstreamAddress.address,
      ports: [0],
      targetPorts: [upstreamAddress.port],
    });

    const relayGroup = await startRelayGroup([{
      listenHost: '127.0.0.1',
      listenPort,
      targetHost: upstreamAddress.address,
      targetPort: upstreamAddress.port,
    }]);

    try {
      const [relayServer] = relayGroup.relays;
      const relayAddress = relayServer.server.address();
      const client = await connect(relayAddress.port);
      const replyPromise = new Promise((resolve) => {
        client.once('data', (chunk) => resolve(String(chunk)));
      });

      client.write('ping');
      await expect(replyPromise).resolves.toBe('PING');
      client.end();
    } finally {
      await closeRelayGroup(relayGroup);
    }
  });
});
