import { AuditLogger } from '../events/audit';
import { EventBus } from '../events/bus';
import { HeadlessRenderer } from '../events/renderers/headless';
import { JsonRenderer } from '../events/renderers/json';
import type { EventMode } from '../events/schema';
import type { StateStore } from '../state/store';

export type EventSystem = {
  bus: EventBus;
  mode: EventMode;
};

export function initEvents(state: StateStore, mode: EventMode): EventSystem {
  const bus = new EventBus();
  const audit = new AuditLogger(state.auditDir);
  const renderer = mode === 'json' ? new JsonRenderer() : new HeadlessRenderer();

  bus.subscribe(async (event) => {
    renderer.render(event);
    await audit.log(event);
  });

  return { bus, mode };
}
