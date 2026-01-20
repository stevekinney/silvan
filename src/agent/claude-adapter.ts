import { createSdkMcpServer, tool as sdkTool } from '@anthropic-ai/claude-agent-sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  type Armorer,
  type ArmorerTool,
  isArmorer,
  isTool,
  type ToolParametersSchema,
  type ToolResult,
} from 'armorer';
import type { ZodTypeAny } from 'zod';

export type ClaudeAgentSdkTool = ReturnType<typeof sdkTool>;
export type ClaudeAgentSdkServer = ReturnType<typeof createSdkMcpServer>;

export type ClaudeAgentSdkToolConfig = {
  name?: string;
  description?: string;
  schema?: Record<string, unknown>;
};

export type ClaudeAgentSdkToolOptions = {
  toolConfig?: (tool: ArmorerTool) => ClaudeAgentSdkToolConfig;
  formatResult?: (result: ToolResult) => CallToolResult;
};

export type CreateClaudeAgentSdkServerOptions = ClaudeAgentSdkToolOptions & {
  name?: string;
  version?: string;
};

export type ClaudeAgentSdkServerResult = {
  sdkServer: ClaudeAgentSdkServer;
  tools: ClaudeAgentSdkTool[];
  toolNames: string[];
  mutatingToolNames: string[];
  dangerousToolNames: string[];
};

export type ClaudeToolGateOptions = {
  registry: Armorer | ArmorerTool | ArmorerTool[];
  readOnly?: boolean;
  allowMutation?: boolean;
  allowDangerous?: boolean;
  builtin?: {
    readOnly?: string[];
    mutating?: string[];
    dangerous?: string[];
  };
  allowUnknown?: boolean;
  toolConfig?: (tool: ArmorerTool) => ClaudeAgentSdkToolConfig;
  messages?: {
    mutating?: string;
    dangerous?: string;
    unknown?: (toolName: string) => string;
  };
};

export type ClaudeToolGateDecision = { behavior: 'allow' | 'deny'; message?: string };

export function toClaudeAgentSdkTools(
  input: Armorer | ArmorerTool | ArmorerTool[],
  options: ClaudeAgentSdkToolOptions = {},
): ClaudeAgentSdkTool[] {
  const tools = normalizeToTools(input);

  return tools.map((tool) => {
    const override = options.toolConfig?.(tool);
    const name = override?.name ?? tool.name;
    const description = override?.description ?? tool.description;
    const schema = (override?.schema ?? getSchemaShape(tool.schema) ?? {}) as Record<
      string,
      ZodTypeAny
    >;

    return sdkTool(name, description, schema, async (args): Promise<CallToolResult> => {
      const result = await tool.executeWith({ params: args ?? {} });
      return options.formatResult
        ? options.formatResult(result)
        : toSdkToolResult(result);
    });
  });
}

export function createClaudeAgentSdkServer(
  input: Armorer | ArmorerTool | ArmorerTool[],
  options: CreateClaudeAgentSdkServerOptions = {},
): ClaudeAgentSdkServerResult {
  const tools = normalizeToTools(input);
  const toolNames: string[] = [];
  const mutatingToolNames: string[] = [];
  const dangerousToolNames: string[] = [];

  const sdkTools = tools.map((tool) => {
    const override = options.toolConfig?.(tool);
    const name = override?.name ?? tool.name;
    const description = override?.description ?? tool.description;
    const schema = (override?.schema ?? getSchemaShape(tool.schema) ?? {}) as Record<
      string,
      ZodTypeAny
    >;

    toolNames.push(name);
    if (isMutating(tool)) mutatingToolNames.push(name);
    if (isDangerous(tool)) dangerousToolNames.push(name);

    return sdkTool(name, description, schema, async (args): Promise<CallToolResult> => {
      const result = await tool.executeWith({ params: args ?? {} });
      return options.formatResult
        ? options.formatResult(result)
        : toSdkToolResult(result);
    });
  });

  const sdkServer = createSdkMcpServer({
    name: options.name ?? 'armorer-tools',
    version: options.version ?? '0.0.0',
    tools: sdkTools,
  });

  return {
    sdkServer,
    tools: sdkTools,
    toolNames,
    mutatingToolNames,
    dangerousToolNames,
  };
}

export function createClaudeToolGate(
  options: ClaudeToolGateOptions,
): (toolName: string) => Promise<ClaudeToolGateDecision> {
  const readOnly = options.readOnly ?? false;
  const allowMutation = options.allowMutation ?? !readOnly;
  const allowDangerous = options.allowDangerous ?? true;
  const builtin = options.builtin ?? {};
  const allowUnknown = options.allowUnknown ?? false;
  const messages = {
    mutating:
      options.messages?.mutating ??
      (readOnly
        ? 'Read-only mode: mutating tools disabled.'
        : 'Use --apply to allow mutating tools.'),
    dangerous:
      options.messages?.dangerous ??
      (readOnly || !allowMutation
        ? 'Use --apply to allow mutating tools.'
        : 'Use --dangerous to allow this tool.'),
    unknown: options.messages?.unknown ?? ((name: string) => `Tool not allowed: ${name}`),
  };

  const registryTools = normalizeToTools(options.registry);
  const toolInfo = new Map<
    string,
    {
      mutating: boolean;
      dangerous: boolean;
    }
  >();
  for (const tool of registryTools) {
    const override = options.toolConfig?.(tool);
    const name = override?.name ?? tool.name;
    toolInfo.set(name, {
      mutating: isMutating(tool),
      dangerous: isDangerous(tool),
    });
  }

  const readOnlyTools = new Set(builtin.readOnly ?? []);
  const mutatingTools = new Set(builtin.mutating ?? []);
  const dangerousTools = new Set(builtin.dangerous ?? []);

  return (toolName: string) => {
    const info = toolInfo.get(toolName);
    if (info) {
      if (info.mutating && (readOnly || !allowMutation)) {
        return Promise.resolve({ behavior: 'deny', message: messages.mutating });
      }
      if (info.dangerous && !allowDangerous) {
        return Promise.resolve({ behavior: 'deny', message: messages.dangerous });
      }
      return Promise.resolve({ behavior: 'allow' });
    }

    if (readOnlyTools.has(toolName)) {
      return Promise.resolve({ behavior: 'allow' });
    }
    if (mutatingTools.has(toolName)) {
      if (readOnly || !allowMutation) {
        return Promise.resolve({ behavior: 'deny', message: messages.mutating });
      }
      return Promise.resolve({ behavior: 'allow' });
    }
    if (dangerousTools.has(toolName)) {
      if (!allowDangerous) {
        return Promise.resolve({ behavior: 'deny', message: messages.dangerous });
      }
      return Promise.resolve({ behavior: 'allow' });
    }
    if (allowUnknown) {
      return Promise.resolve({ behavior: 'allow' });
    }
    return Promise.resolve({
      behavior: 'deny',
      message: messages.unknown(toolName),
    });
  };
}

function normalizeToTools(input: Armorer | ArmorerTool | ArmorerTool[]): ArmorerTool[] {
  if (isArmorer(input)) {
    return input.tools();
  }
  if (Array.isArray(input)) {
    return input.map((tool) => {
      if (!isTool(tool)) {
        throw new TypeError('Invalid tool input: expected ArmorerTool');
      }
      return tool;
    });
  }
  if (isTool(input)) {
    return [input];
  }
  throw new TypeError('Invalid input: expected tool, tool array, or Armorer');
}

function isMutating(tool: ArmorerTool): boolean {
  const metadata = tool.metadata;
  const tags = tool.tags?.map((tag) => tag.toLowerCase()) ?? [];
  const tagSet = new Set(tags);
  if (metadata?.mutates === true) return true;
  if (metadata?.readOnly === true) return false;
  if (tagSet.has('mutating')) return true;
  if (tagSet.has('readonly') || tagSet.has('read-only')) return false;
  return false;
}

function isDangerous(tool: ArmorerTool): boolean {
  const metadata = tool.metadata;
  const tags = tool.tags?.map((tag) => tag.toLowerCase()) ?? [];
  const tagSet = new Set(tags);
  if (metadata?.dangerous === true) return true;
  if (tagSet.has('dangerous')) return true;
  return false;
}

function toSdkToolResult(result: ToolResult): CallToolResult {
  if (result.outcome === 'error') {
    const message = result.error ?? stringifyResult(result.content);
    const messageText = typeof message === 'string' ? message : stringifyResult(message);
    return {
      content: toTextContent(messageText),
      isError: true,
    };
  }

  const text = stringifyResult(result.result);
  const content = toTextContent(text);
  const structured = toStructuredContent(result.result);

  if (structured) {
    return {
      content,
      structuredContent: structured,
    };
  }

  return { content };
}

function stringifyResult(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return String(value);
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '[unserializable]';
  }
}

function toStructuredContent(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function toTextContent(text: string): CallToolResult['content'] {
  if (!text.length) return [];
  return [{ type: 'text' as const, text }];
}

function getSchemaShape(
  schema: ToolParametersSchema,
): Record<string, unknown> | undefined {
  if (!schema) return undefined;
  const candidate = unwrapSchema(schema);
  return resolveSchemaShape(candidate);
}

function unwrapSchema(schema: ToolParametersSchema): unknown {
  let current: unknown = schema;
  const seen = new Set<unknown>();
  while (current && !seen.has(current)) {
    seen.add(current);
    if (hasShape(current)) {
      return current;
    }
    const next = resolveInnerSchema(current);
    if (next === undefined) {
      break;
    }
    current = next;
  }
  return current;
}

function resolveSchemaShape(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;

  const directShape = resolveShape(value['shape']);
  if (directShape) return directShape;

  const def = value['_def'];
  if (!isRecord(def)) return undefined;
  return resolveShape(def['shape']);
}

function resolveShape(value: unknown): Record<string, unknown> | undefined {
  if (isShapeFactory(value)) {
    const resolved = value();
    return isRecord(resolved) ? resolved : undefined;
  }
  return isRecord(value) ? value : undefined;
}

function resolveInnerSchema(value: unknown): unknown {
  if (!isRecord(value)) return undefined;

  const def = value['_def'];
  if (isRecord(def)) {
    const innerType = def['innerType'];
    if (innerType !== undefined) {
      return innerType;
    }
    const schema = def['schema'];
    if (schema !== undefined) {
      return schema;
    }
  }

  const legacyDef = value['def'];
  if (isRecord(legacyDef)) {
    const out = legacyDef['out'];
    if (out !== undefined) {
      return out;
    }
  }

  return undefined;
}

function hasShape(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value['shape'] !== undefined) return true;
  const def = value['_def'];
  return isRecord(def) && def['shape'] !== undefined;
}

function isShapeFactory(value: unknown): value is () => unknown {
  return typeof value === 'function';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
