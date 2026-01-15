import type { Event } from './schema';

export type EventHandler = (event: Event) => void | Promise<void>;

export class EventBus {
  private handlers = new Set<EventHandler>();

  subscribe(handler: EventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  async emit(event: Event): Promise<void> {
    const results = await Promise.allSettled(
      Array.from(this.handlers, (handler) => Promise.resolve(handler(event))),
    );
    const errors: unknown[] = [];
    for (const result of results) {
      if (result.status === 'rejected') {
        errors.push(result.reason);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, 'Event handler failures');
    }
  }
}
