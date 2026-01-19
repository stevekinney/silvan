import type { Event } from '../schema';

export class JsonRenderer {
  render(event: Event): void {
    if (this.shouldSuppress(event)) {
      return;
    }
    console.log(JSON.stringify(event));
  }

  private shouldSuppress(event: Event): boolean {
    if (process.env['SILVAN_QUIET']) {
      return event.level !== 'warn' && event.level !== 'error';
    }
    if (event.level === 'debug' && !process.env['SILVAN_DEBUG']) {
      return true;
    }
    return false;
  }
}
