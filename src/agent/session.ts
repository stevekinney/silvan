import type { ClaudeSession, ClaudeSessionOptions } from './sdk';
import { createClaudeSession } from './sdk';

export type SessionKey = 'plan' | 'execute' | 'review' | 'verify' | 'pr' | 'recovery';

export type SessionPool = {
  enabled: boolean;
  get: (key: SessionKey, options: ClaudeSessionOptions) => ClaudeSession | undefined;
  close: () => void;
};

export function createSessionPool(enabled: boolean): SessionPool {
  const sessions = new Map<SessionKey, ClaudeSession>();

  return {
    enabled,
    get(key, options) {
      if (!enabled) return undefined;
      const existing = sessions.get(key);
      if (existing) {
        return existing;
      }
      const session = createClaudeSession(options);
      sessions.set(key, session);
      return session;
    },
    close() {
      for (const session of sessions.values()) {
        session.close();
      }
      sessions.clear();
    },
  };
}
