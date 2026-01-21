declare module '@modelcontextprotocol/sdk/types' {
  export type TextContent = {
    type: 'text';
    text: string;
    annotations?: unknown;
    _meta?: Record<string, unknown>;
  };

  export type ContentBlock = TextContent | { type: string; [key: string]: unknown };

  export type CallToolResult = {
    content: ContentBlock[];
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
    _meta?: Record<string, unknown>;
  };

  export type JSONRPCMessage = {
    jsonrpc: '2.0';
    id?: string | number;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: unknown;
  };
}

declare module '@modelcontextprotocol/sdk/types.js' {
  export * from '@modelcontextprotocol/sdk/types';
}
