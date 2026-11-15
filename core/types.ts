import type { z } from 'zod';

/** JSON-serialisable value — used for log payloads and tool args/results. */
export type Json = string | number | boolean | null | undefined | Json[] | { [key: string]: Json };

// ─── Registration contract ──────────────────────────────────────────────────────
// One entry feeds all three surfaces (CLI, agent tool, JSON-RPC). The schema,
// description, and CLI shape live here and nowhere else.

export interface CliShape {
  /** Schema keys mapped to positional CLI args, in order. Absent → all args are named flags. */
  positional?: string[];
}

export interface MethodOptions {
  /** zod schema — authoritative validation on every surface. */
  schema: z.ZodTypeAny;
  /** Reused verbatim as CLI --help text AND agent tool description. */
  description: string;
  cli?: CliShape;
  /** Hide from the agent tool surface (still callable via CLI/RPC). Default false. */
  internal?: boolean;
  /** Expose through the external MCP gateway and its OpenAPI spec. Default true. */
  external?: boolean;
  /**
   * Method only completes meaningfully against a running daemon (live channels, agent
   * session state, fire-and-forget runs). The CLI refuses it with a "start the daemon"
   * hint instead of running it in a throwaway local stack. Default false.
   */
  live?: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Handler = (params: any) => unknown | Promise<unknown>;

export interface RegistryEntry extends MethodOptions {
  name: string;     // 'channel.send'
  service: string;  // owning service, e.g. 'channel'
  handler: Handler;
}

/** JSON-safe registry projection — the shape the three surfaces consume. */
export interface MethodInfo {
  name: string;
  service: string;
  description: string;
  cli?: CliShape;
  internal: boolean;
  /** External MCP exposure; omitted means true. Independent of agent visibility. */
  external?: boolean;
  /** Requires a running daemon (see MethodOptions.live). */
  live: boolean;
  /** JSON Schema derived from the zod schema. */
  schema: unknown;
}

// ─── Service contract ───────────────────────────────────────────────────────────

export interface Service {
  name: string;
  /** Register methods/handlers and open resources. */
  init(bus: Bus): Promise<void> | void;
  /** Close sockets, clear timers, flush — MUST fully release everything init opened. */
  dispose(): Promise<void> | void;
}

/** Every service module exports this; called fresh on each (re)load. */
export type ServiceFactory = () => Service;
export interface ServiceModule { createService: ServiceFactory }

// ─── Bus surface seen by services ───────────────────────────────────────────────

export interface Bus {
  /** Register a callable method. Returns an unregister function. */
  register(name: string, opts: MethodOptions, handler: Handler): () => void;
  /** Remove a method from the registry. Returns true if it existed. */
  unregister(name: string): boolean;
  /** Invoke a registered method (validates params, awaits handler). Throws if unregistered. */
  call<T = unknown>(name: string, params?: unknown): Promise<T>;
  /** Fire a pub/sub event. No listeners → silent no-op. */
  emit(event: string, payload?: unknown): void;
  /** Subscribe to a pub/sub event. Returns an unsubscribe function. */
  on<T = unknown>(event: string, handler: (payload: T) => void): () => void;
  /** Is this method registered? */
  has(name: string): boolean;
  /** Registry projection, optionally scoped to one service. */
  list(service?: string): MethodInfo[];
}
