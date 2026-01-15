declare module 'proper-lockfile/index.js' {
  export type LockOptions = {
    retries?: {
      retries: number;
      factor?: number;
      minTimeout?: number;
      maxTimeout?: number;
    };
  };

  export function lock(
    path: string,
    options?: LockOptions
  ): Promise<() => Promise<void>>;
}
