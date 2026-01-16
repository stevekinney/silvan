type ClaudeSdkModule = typeof import('armorer/claude-agent-sdk');

const fallbackUrl = new URL(
  '../../node_modules/armorer/src/adapters/claude-agent-sdk/index.ts',
  import.meta.url,
);

let module: ClaudeSdkModule;

try {
  module = (await import('armorer/claude-agent-sdk')) as unknown as ClaudeSdkModule;
} catch {
  module = (await import(fallbackUrl.href)) as unknown as ClaudeSdkModule;
}

export const createClaudeAgentSdkServer = module.createClaudeAgentSdkServer;
export const createClaudeToolGate = module.createClaudeToolGate;
