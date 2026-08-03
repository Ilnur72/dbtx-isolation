import { activeCtx, recordFailure, type TestCtx } from '../core/context.js'
import { log, warn } from '../core/log.js'
import { needsTransaction, rewrite } from '../core/rewrite.js'
import type { ClientLike } from '../types.js'

/**
 * Marks a connection as maintenance-only: sequence resets, truncation, the
 * admin work in `admin.ts`. Exempt clients are never rewritten and never made
 * to join the test transaction (SPEC §3.7). `Symbol.for` so a client marked by
 * a different copy of dbtx is still recognised.
 */
export const EXEMPT = Symbol.for('dbtx.exempt')

const ORIGINAL_QUERY = Symbol.for('dbtx.originalQuery')
const ORIGINAL_CONNECT = Symbol.for('dbtx.originalConnect')
const ORIGINAL_END = Symbol.for('dbtx.originalEnd')
/** SPEC §3.3: keep the real `release` so it can be restored. */
const ORIGINAL_RELEASE = Symbol.for('dbtx.originalRelease')
const BEGUN = Symbol.for('dbtx.begun')
const PATCHED = Symbol.for('dbtx.patched')

type QueryFn = (this: PgClient, ...args: unknown[]) => unknown
type ReleaseFn = (err?: unknown) => void
type ConnectFn = (this: PgPool, ...args: unknown[]) => unknown
type EndFn = (this: PgPool, ...args: unknown[]) => unknown
type ConnectCallback = (err: unknown, client?: PgClient, release?: ReleaseFn) => void

/** The parts of `pg.Client` we touch. */
export interface PgClient extends ClientLike {
  query: QueryFn
  release?: ReleaseFn
}

/** The parts of `pg.Pool` we touch. */
export interface PgPool {
  connect: ConnectFn
  end: EndFn
}

/** A constructed `pg.Client`, as `admin.ts` uses it. */
export interface PgClientInstance extends PgClient {
  connect(): Promise<void>
  end(): Promise<void>
}

/** The parts of the `pg` module we touch. */
export interface PgModuleLike {
  Client: {
    new (config: { connectionString: string }): PgClientInstance
    prototype: PgClient
  }
  Pool: { prototype: PgPool }
}

function getFlag(target: object, key: symbol): unknown {
  return (target as Record<symbol, unknown>)[key]
}

function setFlag(target: object, key: symbol, value: unknown): void {
  ;(target as Record<symbol, unknown>)[key] = value
}

function clearFlag(target: object, key: symbol): void {
  delete (target as Record<symbol, unknown>)[key]
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

/**
 * A Submittable — `pg.Cursor`, `pg-query-stream`. `Client.query` detects these
 * by their `submit` method and returns them synchronously instead of a
 * promise, which is why the wrapper below never awaits anything.
 */
function isSubmittable(target: unknown): boolean {
  return (
    typeof target === 'object' &&
    target !== null &&
    typeof (target as { submit?: unknown }).submit === 'function'
  )
}

/**
 * The SQL out of any of the shapes `query()` accepts: `query(text)`,
 * `query(text, values)`, `query(text, cb)`, `query(config)`,
 * `query(config, cb)` and a Submittable, where the text hangs off the object.
 */
function textOf(target: unknown): string | undefined {
  if (typeof target === 'string') return target
  if (typeof target === 'object' && target !== null) {
    const text = (target as { text?: unknown }).text
    if (typeof text === 'string') return text
  }
  return undefined
}

/** Put rewritten SQL back into whichever shape it came from. */
function withText(target: unknown, text: string): unknown {
  if (typeof target === 'string') return text
  if (isSubmittable(target)) {
    // A Cursor or QueryStream carries state we cannot clone, so this one is
    // rewritten in place.
    ;(target as { text: string }).text = text
    return target
  }
  return { ...(target as object), text }
}

/** Mark a connection as maintenance-only (SPEC §3.7). */
export function exempt<T extends ClientLike>(client: T): T {
  setFlag(client, EXEMPT, true)
  return client
}

/** Undo {@link exempt}. */
export function unexempt<T extends ClientLike>(client: T): T {
  clearFlag(client, EXEMPT)
  return client
}

/** Whether this connection is maintenance-only. */
export function isExempt(client: ClientLike): boolean {
  return getFlag(client, EXEMPT) === true
}

/** Whether dbtx has opened the test transaction on this connection. */
export function hasBegun(client: ClientLike): boolean {
  return getFlag(client, BEGUN) === true
}

/**
 * The backend's own view of this connection: `'I'` idle, `'T'` inside a
 * transaction, `'E'` inside a failed one, `null` before the first query. pg
 * refreshes it from every ReadyForQuery message, so it is the ground truth.
 *
 * Undefined when the driver does not expose it — older `pg`, or `pg-native`.
 */
export function transactionStatus(client: ClientLike): 'I' | 'T' | 'E' | null | undefined {
  const candidate = (client as { getTransactionStatus?: unknown }).getTransactionStatus
  if (typeof candidate !== 'function') return undefined
  try {
    return (candidate as () => 'I' | 'T' | 'E' | null).call(client)
  } catch (err) {
    log('getTransactionStatus threw:', err)
    return undefined
  }
}

/**
 * Verify, from the backend rather than from our own bookkeeping, that a client
 * dbtx opened a transaction on is still inside it.
 *
 * `'I'` means something committed the outer transaction — a transaction-control
 * statement dbtx failed to recognise, most likely. That is the silent
 * corruption this whole library exists to prevent, so it is reported rather
 * than swallowed. Returns an error instead of throwing so the caller can still
 * finish cleaning up.
 */
export function isolationBreach(client: ClientLike): Error | undefined {
  if (!hasBegun(client)) return undefined
  const status = transactionStatus(client)
  if (status === undefined || status === 'T' || status === 'E') return undefined
  return new Error(
    `dbtx: this connection is no longer inside the test transaction (backend status ` +
      `${JSON.stringify(status)}). Something committed or ended it — usually a ` +
      'transaction-control statement dbtx did not recognise. Anything this test wrote ' +
      'has been left in the database.',
  )
}

/**
 * Bound a driver call in time. Both places that use this talk to a connection
 * that may already be gone, and neither may hang the run.
 */
async function withDeadline<T>(
  work: () => Promise<T>,
  ms: number,
  onTimeout: () => Error,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(onTimeout())
        }, ms)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Postgres: `current transaction is aborted, commands ignored until ...`. */
const IN_FAILED_TRANSACTION = '25P02'

/**
 * Check isolation only once the connection has caught up with itself.
 *
 * `getTransactionStatus()` is updated from the backend's ReadyForQuery
 * message, but a query's promise settles one message earlier, on
 * CommandComplete or ErrorResponse — which may arrive in a different socket
 * read. So immediately after a statement the status can still describe the
 * *previous* one. Reading it then would both miss real breaches and, worse,
 * invent one: a write that was never awaited could leave the status at 'I'
 * from before the lazy BEGIN landed.
 *
 * A round trip removes the ambiguity. It also drains the client's queue, since
 * `pg` runs a connection's queries in order, so anything the test fired and
 * forgot has finished by the time this resolves.
 */
export async function checkIsolation(
  client: ClientLike,
  options: { timeoutMs?: number } = {},
): Promise<Error | undefined> {
  if (!hasBegun(client)) return undefined
  const timeoutMs = options.timeoutMs ?? 5_000
  const target = client as PgClient
  // The unpatched query, always: this probe must never be rewritten and must
  // never be the statement that triggers a lazy BEGIN.
  const query = (getFlag(target, ORIGINAL_QUERY) as QueryFn | undefined) ?? target.query

  try {
    // Its own deadline rather than the rollback's. pg runs a connection's
    // queries in order, so a test that walked away from a half-read Cursor
    // leaves this probe queued behind it forever.
    await withDeadline(
      async () => query.call(target, 'SELECT 1'),
      timeoutMs,
      () =>
        new Error(
          `dbtx: the connection did not answer within ${timeoutMs}ms, so its transaction ` +
            'state could not be confirmed. An unfinished Cursor or query stream will do this.',
        ),
    )
  } catch (err) {
    if ((err as { code?: string }).code === IN_FAILED_TRANSACTION) {
      // The transaction is aborted, which means we are very much still in it.
      return undefined
    }
    // Something else is wrong with this connection; the rollback that follows
    // will report it properly, and guessing here would only add noise.
    log('could not settle the connection before checking isolation:', err)
    return undefined
  }

  return isolationBreach(target)
}

/** Thrown when a rollback does not come back — a dead connection, usually. */
export class DbtxRollbackTimeoutError extends Error {
  constructor(ms: number) {
    super(
      `dbtx: ROLLBACK did not complete within ${ms}ms. The connection is probably gone; ` +
        'the test transaction could not be undone and later tests may see its rows.',
    )
    this.name = 'DbtxRollbackTimeoutError'
  }
}

/**
 * Roll back the test transaction on one client, using the *unpatched* query so
 * the statement is not itself rewritten. Fully awaited by `afterEach`, since a
 * fire-and-forget rollback is the root of the flakiness we are avoiding
 * (SPEC §3.8) — but never unbounded: a dead connection would otherwise hang
 * the whole run.
 *
 * Failures are logged unconditionally and returned rather than thrown, so the
 * caller can roll back the remaining clients before deciding what to do.
 */
export async function rollbackClient(
  client: ClientLike,
  options: { timeoutMs?: number } = {},
): Promise<Error | undefined> {
  if (!hasBegun(client)) return undefined
  const timeoutMs = options.timeoutMs ?? 10_000
  const target = client as PgClient
  const query = (getFlag(target, ORIGINAL_QUERY) as QueryFn | undefined) ?? target.query

  try {
    await withDeadline(
      async () => query.call(target, 'ROLLBACK'),
      timeoutMs,
      () => new DbtxRollbackTimeoutError(timeoutMs),
    )
    log('rolled back the test transaction')
    return undefined
  } catch (err) {
    warn('ROLLBACK failed; this connection may be left dirty:', err)
    return err instanceof Error ? err : new Error(String(err))
  } finally {
    clearFlag(target, BEGUN)
  }
}

/* --------------------------------------------------------------------------
 * Pinned connections (SPEC §3.3)
 * ----------------------------------------------------------------------- */

interface Pin {
  pool: PgPool
  promise: Promise<PgClient>
  /** Filled once the connection resolves, so teardown can be synchronous. */
  holder: { client?: PgClient }
}

const pins = new WeakMap<PgPool, Pin>()
/** Iterable view of {@link pins}, cleared as pins are released. */
const activePins = new Set<Pin>()

function pinFor(pool: PgPool, connect: ConnectFn): Promise<PgClient> {
  const existing = pins.get(pool)
  if (existing !== undefined) return existing.promise

  const holder: { client?: PgClient } = {}
  const promise = Promise.resolve(connect.call(pool) as PromiseLike<PgClient>).then((client) => {
    holder.client = client
    const original = client.release
    if (typeof original === 'function') {
      setFlag(client, ORIGINAL_RELEASE, original.bind(client))
    }
    // The ORM handing this client back to the pool must not end the test
    // transaction, so release becomes a no-op — but a release(err) means the
    // application is discarding a broken connection, and swallowing that
    // silently is how a hung test becomes impossible to explain.
    client.release = (err?: unknown): void => {
      if (err !== undefined && err !== null && err !== false) {
        warn('release(err) on the pinned connection was ignored to keep the test transaction alive:', err)
      } else {
        log('release() on the pinned connection ignored')
      }
    }
    log('pinned a connection for this pool')
    return client
  })

  const pin: Pin = { pool, promise, holder }
  // Registered before the connection resolves so a second connect() during the
  // handshake gets the same pin rather than opening a second connection.
  pins.set(pool, pin)
  activePins.add(pin)
  return promise
}

function restoreRelease(client: PgClient): void {
  const original = getFlag(client, ORIGINAL_RELEASE) as ReleaseFn | undefined
  if (typeof original !== 'function') return
  clearFlag(client, ORIGINAL_RELEASE)
  client.release = original
  // The application's own release() calls were swallowed, so this is the one
  // that actually returns the connection to the pool.
  try {
    original()
  } catch (err) {
    warn('releasing the pinned connection failed:', err)
  }
}

async function unpin(pin: Pin): Promise<void> {
  pins.delete(pin.pool)
  activePins.delete(pin)
  let client = pin.holder.client
  if (client === undefined) {
    try {
      client = await pin.promise
    } catch {
      return // the connection never opened; nothing to restore
    }
  }
  restoreRelease(client)
}

/**
 * Hand every pinned connection back to its pool and restore its `release`.
 * Called after the rollbacks in `afterEach`, and on `Pool.end()`.
 */
export async function releasePins(): Promise<void> {
  await Promise.all([...activePins].map(unpin))
}

/** Every pinned connection that has finished connecting. */
export function pinnedClients(): PgClient[] {
  const clients: PgClient[] = []
  for (const pin of activePins) {
    if (pin.holder.client !== undefined) clients.push(pin.holder.client)
  }
  return clients
}

/* --------------------------------------------------------------------------
 * The patch
 * ----------------------------------------------------------------------- */

/**
 * Patch `Client.prototype.query`, `Pool.prototype.connect` and
 * `Pool.prototype.end` on the given `pg` module.
 *
 * Idempotent: patching twice does not double-wrap, and {@link unpatchPg}
 * restores the originals saved under symbols.
 *
 * Returns true if this call is what installed the patch.
 */
export function patchPg(pg: PgModuleLike): boolean {
  const clientProto = pg.Client.prototype
  const poolProto = pg.Pool.prototype

  if (getFlag(clientProto, PATCHED) === true) {
    log('pg is already patched')
    return false
  }

  const originalQuery = clientProto.query
  const originalConnect = poolProto.connect
  const originalEnd = poolProto.end

  /**
   * Open the test transaction on this connection, once, the first time it is
   * asked to do something that needs one (SPEC §3.1 — lazy BEGIN).
   *
   * There is nothing to await: `pg` runs a client's queries strictly in the
   * order they were handed to it, so a BEGIN enqueued here is guaranteed to
   * reach the server before the statement that triggered it. That is what lets
   * the wrapper below return the driver's own value untouched, whether that is
   * a promise, `undefined` for a callback, or a Submittable.
   */
  function ensureBegun(client: PgClient, ctx: TestCtx, needed: boolean): void {
    if (!needed || hasBegun(client)) return
    // Marked before dispatch so two queries in the same tick cannot both BEGIN.
    setFlag(client, BEGUN, true)
    ctx.clients.add(client)
    log('lazy BEGIN for context', ctx.id)
    const pending = originalQuery.call(client, 'BEGIN')
    // Nothing awaits this BEGIN, so its rejection has to be caught here or Node
    // reports an unhandled rejection and the real cause is lost. The error is
    // parked on the context for afterEach to surface.
    if (isPromiseLike(pending)) {
      Promise.resolve(pending).catch((err: unknown) => {
        warn('BEGIN failed; this test is not isolated:', err)
        recordFailure(ctx, err)
      })
    }
  }

  clientProto.query = function patchedQuery(this: PgClient, ...args: unknown[]): unknown {
    const ctx = activeCtx()
    const target = args[0]
    if (ctx === undefined || isExempt(this) || target === null || target === undefined) {
      return originalQuery.apply(this, args)
    }

    // Counted before anything can throw: a test that ends with zero
    // intercepted statements is how "dbtx patched a different copy of pg"
    // announces itself.
    ctx.intercepted += 1

    const text = textOf(target)
    if (text === undefined) {
      // A shape we cannot read the SQL out of. Treat it as a write so it stays
      // inside the test transaction rather than escaping isolation.
      ensureBegun(this, ctx, true)
      return originalQuery.apply(this, args)
    }

    const next = rewrite(text, ctx)
    if (next !== text) args[0] = withText(target, next)
    ensureBegun(this, ctx, needsTransaction(next))
    return originalQuery.apply(this, args)
  }

  poolProto.connect = function patchedConnect(this: PgPool, ...args: unknown[]): unknown {
    if (activeCtx() === undefined) return originalConnect.apply(this, args)

    const callback = typeof args[0] === 'function' ? (args[0] as ConnectCallback) : undefined
    const promise = pinFor(this, originalConnect)
    if (callback === undefined) return promise

    // `pool.query()` takes this path, so it has to match pg's own contract:
    // (err, client, done). `done` is the neutered release.
    promise.then(
      (client) => {
        callback(undefined, client, client.release)
      },
      (err: unknown) => {
        callback(err)
      },
    )
    return undefined
  }

  poolProto.end = function patchedEnd(this: PgPool, ...args: unknown[]): unknown {
    const pin = pins.get(this)
    if (pin === undefined) return originalEnd.apply(this, args)

    // A pinned connection is checked out, so end() would wait for it forever.
    // Give it back first (SPEC §3.3).
    const finish = unpin(pin).then(() => originalEnd.apply(this, args))

    const callback = typeof args[0] === 'function' ? (args[0] as (err?: unknown) => void) : undefined
    if (callback !== undefined) {
      finish.catch((err: unknown) => {
        callback(err)
      })
      return undefined
    }
    return finish
  }

  setFlag(clientProto, ORIGINAL_QUERY, originalQuery)
  setFlag(poolProto, ORIGINAL_CONNECT, originalConnect)
  setFlag(poolProto, ORIGINAL_END, originalEnd)
  setFlag(clientProto, PATCHED, true)
  log('patched pg')
  return true
}

/** Restore everything {@link patchPg} replaced. Idempotent. */
export function unpatchPg(pg: PgModuleLike): boolean {
  const clientProto = pg.Client.prototype
  const poolProto = pg.Pool.prototype

  if (getFlag(clientProto, PATCHED) !== true) return false

  const originalQuery = getFlag(clientProto, ORIGINAL_QUERY) as QueryFn | undefined
  const originalConnect = getFlag(poolProto, ORIGINAL_CONNECT) as ConnectFn | undefined
  const originalEnd = getFlag(poolProto, ORIGINAL_END) as EndFn | undefined

  if (originalQuery !== undefined) clientProto.query = originalQuery
  if (originalConnect !== undefined) poolProto.connect = originalConnect
  if (originalEnd !== undefined) poolProto.end = originalEnd

  clearFlag(clientProto, ORIGINAL_QUERY)
  clearFlag(poolProto, ORIGINAL_CONNECT)
  clearFlag(poolProto, ORIGINAL_END)
  clearFlag(clientProto, PATCHED)
  log('unpatched pg')
  return true
}

/** Whether this `pg` module currently carries the patch. */
export function isPatched(pg: PgModuleLike): boolean {
  return getFlag(pg.Client.prototype, PATCHED) === true
}
