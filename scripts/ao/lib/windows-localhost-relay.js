import net from 'node:net';

const NOOP_LOGGER = {
  info() {},
  warn() {},
  error() {},
};

function closeSocket(socket) {
  if (!socket || socket.destroyed) {
    return;
  }
  socket.destroy();
}

function listen(server, listenPort, listenHost) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(listenPort, listenHost);
  });
}

export function createSamePortRelayMappings({
  targetHost,
  ports,
  listenHost = '127.0.0.1',
  targetPorts = null,
}) {
  if (!targetHost || typeof targetHost !== 'string') {
    throw new Error('targetHost is required');
  }

  if (!Array.isArray(ports) || ports.length === 0) {
    throw new Error('ports must be a non-empty array');
  }

  if (targetPorts !== null) {
    if (!Array.isArray(targetPorts) || targetPorts.length !== ports.length) {
      throw new Error('targetPorts must match ports length when provided');
    }
  }

  return ports.map((port, index) => ({
    listenHost,
    listenPort: port,
    targetHost,
    targetPort: targetPorts ? targetPorts[index] : port,
  }));
}

export async function startRelay(mapping, options = {}) {
  const logger = options.logger ?? NOOP_LOGGER;

  const server = net.createServer((clientSocket) => {
    const upstreamSocket = net.createConnection({
      host: mapping.targetHost,
      port: mapping.targetPort,
    });

    const destroyPair = () => {
      closeSocket(clientSocket);
      closeSocket(upstreamSocket);
    };

    upstreamSocket.once('connect', () => {
      clientSocket.pipe(upstreamSocket);
      upstreamSocket.pipe(clientSocket);
    });

    clientSocket.on('error', (error) => {
      logger.warn(
        `relay client error on ${mapping.listenHost}:${mapping.listenPort}: ${error.message}`,
      );
      destroyPair();
    });
    upstreamSocket.on('error', (error) => {
      logger.warn(
        `relay upstream error for ${mapping.targetHost}:${mapping.targetPort}: ${error.message}`,
      );
      destroyPair();
    });
    clientSocket.on('close', () => closeSocket(upstreamSocket));
    upstreamSocket.on('close', () => closeSocket(clientSocket));
  });

  await listen(server, mapping.listenPort, mapping.listenHost);
  const address = server.address();
  logger.info(
    `relay listening on ${mapping.listenHost}:${typeof address === 'object' ? address.port : mapping.listenPort} -> ${mapping.targetHost}:${mapping.targetPort}`,
  );

  return {
    mapping,
    server,
  };
}

export async function closeRelay(relay) {
  if (!relay?.server || !relay.server.listening) {
    return;
  }

  await new Promise((resolve, reject) => {
    relay.server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export async function startRelayGroup(mappings, options = {}) {
  const relays = [];

  try {
    for (const mapping of mappings) {
      relays.push(await startRelay(mapping, options));
    }
  } catch (error) {
    await closeRelayGroup({ relays });
    throw error;
  }

  return { relays };
}

export async function closeRelayGroup(group) {
  const relays = [...(group?.relays ?? [])].reverse();
  for (const relay of relays) {
    await closeRelay(relay);
  }
}
