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
    await Promise.allSettled(
      Array.from(this.handlers, (handler) => Promise.resolve(handler(event))),
    );
  }
}
