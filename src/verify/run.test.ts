import { describe, expect, test } from 'bun:test';

import { configSchema } from '../config/schema';
import { runVerifyCommands } from './run';

describe('runVerifyCommands', () => {
  test('injects a verification port into command env', async () => {
    const originalPort = process.env['SILVAN_VERIFY_PORT'];
    const originalBaseUrl = process.env['SILVAN_VERIFY_BASE_URL'];

    try {
      process.env['SILVAN_VERIFY_PORT'] = '5555';
      delete process.env['SILVAN_VERIFY_BASE_URL'];

      const config = configSchema.parse({
        verify: {
          commands: [
            {
              name: 'env',
              cmd: 'bun',
              args: [
                '-e',
                'console.log(JSON.stringify({ port: process.env.SILVAN_VERIFY_PORT, baseUrl: process.env.SILVAN_VERIFY_BASE_URL, portEnv: process.env.PORT }))',
              ],
            },
          ],
        },
      });

      const result = await runVerifyCommands(config);
      const payload = JSON.parse(result.results[0]?.stdout.trim() ?? '{}') as {
        port?: string;
        baseUrl?: string;
        portEnv?: string;
      };

      expect(payload.port).toBe('5555');
      expect(payload.portEnv).toBe('5555');
      expect(payload.baseUrl).toBe('http://127.0.0.1:5555');
    } finally {
      if (originalPort === undefined) {
        delete process.env['SILVAN_VERIFY_PORT'];
      } else {
        process.env['SILVAN_VERIFY_PORT'] = originalPort;
      }
      if (originalBaseUrl === undefined) {
        delete process.env['SILVAN_VERIFY_BASE_URL'];
      } else {
        process.env['SILVAN_VERIFY_BASE_URL'] = originalBaseUrl;
      }
    }
  });

  test('rejects invalid SILVAN_VERIFY_PORT values', async () => {
    const originalPort = process.env['SILVAN_VERIFY_PORT'];

    try {
      process.env['SILVAN_VERIFY_PORT'] = '99999';
      const config = configSchema.parse({
        verify: {
          commands: [
            {
              name: 'noop',
              cmd: 'bun',
              args: ['-e', 'process.exit(0)'],
            },
          ],
        },
      });

      return expect(runVerifyCommands(config)).rejects.toThrow('SILVAN_VERIFY_PORT');
    } finally {
      if (originalPort === undefined) {
        delete process.env['SILVAN_VERIFY_PORT'];
      } else {
        process.env['SILVAN_VERIFY_PORT'] = originalPort;
      }
    }
  });
});
