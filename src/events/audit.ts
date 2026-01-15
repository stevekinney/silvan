import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Event } from './schema';

export class AuditLogger {
  constructor(private readonly auditDir: string) {}

  async log(event: Event): Promise<void> {
    const filename = join(this.auditDir, `${event.runId}.jsonl`);
    await appendFile(filename, `${JSON.stringify(event)}\n`);
  }
}
