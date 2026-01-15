import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Event } from './schema';

export class AuditLogger {
  private disabled = false;
  private warned = false;

  constructor(private readonly auditDir: string) {}

  async log(event: Event): Promise<void> {
    if (this.disabled) return;
    const filename = join(this.auditDir, `${event.runId}.jsonl`);
    try {
      await appendFile(filename, `${JSON.stringify(event)}\n`);
    } catch (error) {
      this.disabled = true;
      if (!this.warned) {
        this.warned = true;
        const message =
          error instanceof Error ? error.message : 'Unknown audit log failure';
        process.stderr.write(`silvan: audit logging disabled (${message}).\n`);
      }
    }
  }
}
