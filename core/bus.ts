/**
 * The Bus — the single owner of the method registry and the only wrapper for all
 * services. `register`/`unregister`/`call`/`emit`/`on` and the registry projection
 * consumed by all three surfaces (CLI, agent tools, JSON-RPC) live here.
 *
 * Two distinct concepts, deliberately not conflated:
 *   - Methods (registry): register / call. Validated by zod. Surfaced everywhere.
 *   - Events (pub/sub): emit / on. Unvalidated broadcast. emit with no listeners
 *     is a silent no-op.
 */

import EventEmitter from 'node:events';
import { z } from 'zod';
import type { Bus, Handler, MethodInfo, MethodOptions, RegistryEntry } from './types.js';
import { MethodNotFoundError, ValidationError } from './errors.js';

/** Per-service wiring the bus added, so a reload can release it without service help. */
interface Wiring {
  methods: Set<string>;
  offs: Array<() => void>;
}

export class EmitterBus implements Bus {
  private readonly registry = new Map<string, RegistryEntry>();
  private readonly ee = new EventEmitter();
  private readonly wiring = new Map<string, Wiring>();
  /** Set by the loader around a service's init() so register/on attribute correctly. */
  private loadingService: string | null = null;

  constructor() {
    this.ee.setMaxListeners(0); // a long-lived server has many legitimate listeners
    this.registerIntrospection();
  }

  // ── Loader hook ────────────────────────────────────────────────────────────────
  // The loader brackets a service's (async) init() with beginLoading/endLoading so
  // every register()/on() it does is attributed to that service. Services never load
  // concurrently, so loadingService stays correct across awaits inside init().

  beginLoading(service: string): void {
    this.loadingService = service;
    if (!this.wiring.has(service)) this.wiring.set(service, { methods: new Set(), offs: [] });
  }

  endLoading(): void {
    this.loadingService = null;
  }

  /** Release everything the bus wired for a service (methods + event listeners). */
  releaseService(service: string): void {
    const w = this.wiring.get(service);
    if (!w) return;
    for (const off of w.offs) off();
    for (const name of w.methods) this.registry.delete(name);
    this.wiring.delete(service);
  }

  // ── Registry ────────────────────────────────────────────────────────────────────

  register(name: string, opts: MethodOptions, handler: Handler): () => void {
    if (this.registry.has(name)) {
      throw new Error(`Method already registered: ${name}`);
    }
    const service = this.loadingService ?? name.split('.')[0];
    this.registry.set(name, { name, service, handler, ...opts, internal: opts.internal ?? false });
    this.wiring.get(service)?.methods.add(name);
    return () => this.unregister(name);
  }

  unregister(name: string): boolean {
    const entry = this.registry.get(name);
    if (!entry) return false;
    this.registry.delete(name);
    this.wiring.get(entry.service)?.methods.delete(name);
    return true;
  }

  has(name: string): boolean {
    return this.registry.has(name);
  }

  async call<T = unknown>(name: string, params?: unknown): Promise<T> {
    const entry = this.registry.get(name);
    if (!entry) throw new MethodNotFoundError(name);
    const parsed = entry.schema.safeParse(params ?? {});
    if (!parsed.success) throw new ValidationError(name, parsed.error);
    return await entry.handler(parsed.data) as T;
  }

  list(service?: string): MethodInfo[] {
    const out: MethodInfo[] = [];
    for (const e of this.registry.values()) {
      if (service && e.service !== service) continue;
      out.push({
        name: e.name,
        service: e.service,
        description: e.description,
        cli: e.cli,
        internal: e.internal ?? false,
        external: e.external ?? true,
        live: e.live ?? false,
        schema: toJsonSchema(e.schema),
      });
    }
    return out;
  }

  // ── Events (pub/sub) ──────────────────────────────────────────────────────────

  emit(event: string, payload?: unknown): void {
    this.ee.emit(event, payload); // no listeners → no-op
  }

  on<T = unknown>(event: string, handler: (payload: T) => void): () => void {
    const fn = handler as (payload: unknown) => void;
    this.ee.on(event, fn);
    const off = () => this.ee.off(event, fn);
    if (this.loadingService) this.wiring.get(this.loadingService)?.offs.push(off);
    return off;
  }

  // ── Built-in introspection (the registry describing itself) ─────────────────────

  private registerIntrospection(): void {
    this.beginLoading('bus');
    this.register('bus.list', {
      description: 'List registered methods, optionally scoped to one service. Source of truth for all three surfaces.',
      schema: z.object({ service: z.string().optional() }),
      cli: { positional: ['service'] },
      internal: true,
    }, (p: { service?: string }) => this.list(p.service));

    this.register('bus.has', {
      description: 'Check whether a method is registered.',
      schema: z.object({ method: z.string() }),
      cli: { positional: ['method'] },
      internal: true,
    }, (p: { method: string }) => ({ registered: this.has(p.method) }));
    this.endLoading();
  }
}

/** Convert a zod schema to JSON Schema, swallowing conversion failures. */
function toJsonSchema(schema: z.ZodTypeAny): unknown {
  try {
    // Zod v4 has a built-in toJSONSchema method.
    return schema.toJSONSchema();
  } catch {
    return {};
  }
}
