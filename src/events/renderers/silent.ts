import type { Event } from '../schema';

export class SilentRenderer {
  render(_event: Event): void {
    // Intentionally no output for UI mode.
  }
}
