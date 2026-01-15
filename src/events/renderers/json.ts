import type { Event } from '../schema';

export class JsonRenderer {
  render(event: Event): void {
    console.log(JSON.stringify(event));
  }
}
