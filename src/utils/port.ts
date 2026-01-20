import { createServer } from 'node:net';

const MIN_PORT = 1;
const MAX_PORT = 65535;

export function parsePort(value: string, label: string): number {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw new Error(
      `Invalid ${label} value: "${value}". Expected a valid port number (${MIN_PORT}-${MAX_PORT}).`,
    );
  }
  return port;
}

export function findFreePort(preferredPort = 4173): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();

    server.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        server.listen(0, '127.0.0.1');
      } else {
        reject(error);
      }
    });

    server.on('listening', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });

    server.listen(preferredPort, '127.0.0.1');
  });
}
