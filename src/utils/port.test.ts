import { createServer } from 'node:net';

import { describe, expect, test } from 'bun:test';

import { findFreePort, parsePort } from './port';

function listen(server: ReturnType<typeof createServer>, port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address === 'object' && address) {
        resolve(address.port);
      } else {
        reject(new Error('Failed to resolve listening port.'));
      }
    });
  });
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe('port utilities', () => {
  test('parsePort validates numeric ports', () => {
    expect(parsePort('4173', 'TEST_PORT')).toBe(4173);
    expect(() => parsePort('0', 'TEST_PORT')).toThrow('TEST_PORT');
    expect(() => parsePort('70000', 'TEST_PORT')).toThrow('TEST_PORT');
  });

  test('findFreePort skips an in-use port', async () => {
    const server = createServer();
    const port = await listen(server);
    try {
      const freePort = await findFreePort(port);
      expect(freePort).toBeGreaterThan(0);
      expect(freePort).not.toBe(port);
    } finally {
      await close(server);
    }
  });
});
