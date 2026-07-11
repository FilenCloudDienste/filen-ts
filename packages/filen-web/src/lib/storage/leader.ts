import * as Comlink from "comlink"
import { serializeError, deserializeError, type SerializedError } from "@filen/utils" // preserves stack traces across the BroadcastChannel
import DbWorker from "@/workers/db.worker.ts?worker" // matches the sdk worker's own spawn convention (src/lib/sdk/client.ts) — confirmed working in dev + build
import type { StorageApi } from "@/workers/db.worker"
import { log } from "@/lib/log"

const LOCK = "filen-web-db-leader"
const CHANNEL = "filen-web-db-rpc"

export interface StorageHandle {
	role: "leader" | "follower"
	api: StorageApi
}

// Leadership as a live signal (not just the one-shot role on the handle): the notes outbox REUSES this
// db lock as its single leadership election — the leader tab owns the outbox push loop + disk, and on
// leader death the promoted tab flips to "leader" here so the outbox can hand the loop over. No second
// lock, no change to the db RPC protocol (Req/Res/Hello are untouched).
let currentRole: "leader" | "follower" | null = null
const leadershipListeners: Set<() => void> = new Set<() => void>()

export function storageRole(): "leader" | "follower" | null {
	return currentRole
}

// Subscribe to leadership changes (fires on promotion follower→leader). Returns an unsubscribe fn.
export function onStorageLeadershipChange(listener: () => void): () => void {
	leadershipListeners.add(listener)

	return () => {
		leadershipListeners.delete(listener)
	}
}

function setStorageRole(role: "leader" | "follower"): void {
	if (currentRole === role) {
		return
	}

	currentRole = role

	for (const listener of leadershipListeners) {
		listener()
	}
}

interface Req {
	kind: "req"
	id: string
	method: keyof StorageApi
	args: unknown[]
}
interface Res {
	kind: "res"
	id: string
	ok: boolean
	value?: unknown
	error?: SerializedError
}
type Hello = { kind: "leader-ready" } | { kind: "leader?" }
type Msg = Req | Res | Hello

const STORAGE_METHODS = ["open", "kvGet", "kvSet", "kvDelete", "kvKeys"] as const satisfies readonly (keyof StorageApi)[]

// A promise plus its externally-exposed settle functions — lets a listener registered before the
// promise exists (e.g. inside the promise's own executor) settle it later without a self-reference
// through the `const` binding that is still being initialized (that self-reference was rev-1's bug).
function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
	let resolveFn: ((value: T) => void) | undefined
	let rejectFn: ((reason: unknown) => void) | undefined
	const promise = new Promise<T>((res, rej) => {
		resolveFn = res
		rejectFn = rej
	})

	// The executor above runs synchronously during `new Promise`, so both are always assigned here.
	return {
		promise,
		resolve: value => {
			resolveFn?.(value)
		},
		reject: reason => {
			rejectFn?.(reason)
		}
	}
}

// Spin up this tab's own db worker, open OPFS, and start serving the RPC channel — the work a tab does
// the moment it holds the lock, whether it was the FIRST leader or a promoted follower. Returns the
// direct worker api. A thrown open() (see db.worker.ts) propagates so the caller releases the lock and
// the next queued tab is granted instead of everyone hanging.
async function becomeLeader(): Promise<StorageApi> {
	const worker = new DbWorker()
	const remote = Comlink.wrap<StorageApi>(worker)

	await remote.open()

	const ch = new BroadcastChannel(CHANNEL)
	ch.onmessage = (ev: MessageEvent<Msg>) => {
		void serve(ev.data, remote, ch)
	}
	ch.postMessage({ kind: "leader-ready" } satisfies Hello)

	// Comlink.Remote<StorageApi> is structurally StorageApi here (every method already returns a Promise).
	return remote
}

// A follower queues a BLOCKING request on the SAME lock (no `ifAvailable`) so the browser hands it
// leadership when the current leader releases (tab close/crash). On grant it becomes a leader and
// MUTATES the already-returned handle in place — every kv caller re-reads `.api` per call (see
// adapter.ts), so the swap from RPC-to-leader to direct-worker takes effect on the next kv op with no
// re-plumbing. Held for the tab's lifetime once granted (chains to the next queued follower on death).
function requestPromotion(handle: StorageHandle): void {
	const promoted = navigator.locks.request(LOCK, async () => {
		const api = await becomeLeader()

		handle.role = "leader"
		handle.api = api
		setStorageRole("leader")

		return new Promise<never>(() => undefined)
	})

	// A failed promotion (e.g. OPFS open() throws) releases the lock so the next queued follower is
	// tried; this tab stays a follower with an api pointed at the now-dead leader (its kv times out) —
	// a degraded state, not a hang, and no worse than the pre-failover behavior.
	void promoted.catch((e: unknown) => {
		log.error("db.leader", "promotion failed", e)
	})
}

export function acquireStorage(): Promise<StorageHandle> {
	return new Promise((resolve, reject) => {
		// Role is decided by the LOCK GRANT (deterministic) — never by racing a timer against open().
		// `.catch(reject)` matters: without it, a rejection from followerHandle() (e.g. the 10s
		// no-leader timeout) would throw inside this callback with nothing left listening — the
		// callback's rejection reaches navigator.locks.request()'s own returned promise, which was
		// otherwise being discarded, and the outer Promise here would then hang forever instead of
		// surfacing the error.
		const granted = navigator.locks.request(LOCK, { ifAvailable: true }, async lock => {
			if (lock === null) {
				const handle = await followerHandle()

				setStorageRole("follower")
				resolve(handle)
				// Queue for leadership so a leader death promotes this tab (reusing this same lock).
				requestPromotion(handle)

				return
			}

			// OPFS is a hard requirement — a thrown open() rejects this whole lock callback, which
			// navigator.locks.request propagates to `granted` below and releases the lock without ever
			// posting "leader-ready"; any waiting follower times out instead of hanging forever.
			const api = await becomeLeader()

			setStorageRole("leader")
			resolve({ role: "leader", api })

			return new Promise<never>(() => undefined) // hold the lock for the tab's lifetime; a queued follower is promoted on release
		})

		void granted.catch(reject)
	})
}

async function serve(msg: Msg, remote: Comlink.Remote<StorageApi>, ch: BroadcastChannel): Promise<void> {
	if (msg.kind === "leader?") {
		ch.postMessage({ kind: "leader-ready" } satisfies Hello)
		return
	}

	if (msg.kind !== "req") {
		return
	}

	try {
		const value = await (remote[msg.method] as (...a: unknown[]) => Promise<unknown>)(...msg.args)
		ch.postMessage({ kind: "res", id: msg.id, ok: true, value } satisfies Res)
	} catch (e) {
		ch.postMessage({
			kind: "res",
			id: msg.id,
			ok: false,
			error: serializeError(e instanceof Error ? e : new Error(String(e)))
		} satisfies Res)
		log.error("db.leader", e)
	}
}

async function followerHandle(): Promise<StorageHandle> {
	const ch = new BroadcastChannel(CHANNEL)
	const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

	const ready = deferred()

	ch.addEventListener("message", (ev: MessageEvent<Msg>) => {
		if (ev.data.kind === "leader-ready") {
			ready.resolve()
		}
	})

	const ping = setInterval(() => {
		ch.postMessage({ kind: "leader?" } satisfies Hello)
	}, 250)

	ch.addEventListener("message", (ev: MessageEvent<Msg>) => {
		if (ev.data.kind !== "res") {
			return
		}

		const p = pending.get(ev.data.id)

		if (!p) {
			return // response addressed to another follower — ids are globally unique
		}

		pending.delete(ev.data.id)

		if (ev.data.ok) {
			p.resolve(ev.data.value)
		} else {
			p.reject(ev.data.error ? deserializeError(ev.data.error) : new Error("db rpc failed"))
		}
	})

	// Teardown must hang off THIS race, not off `ready` — on the 10s no-leader path the rejection
	// comes from the race's own timer while `ready` (settled only by a leader-ready message) stays
	// pending forever, so a `ready.promise.finally(...)` hook would never fire and the ping interval
	// would keep posting `leader?` every 250ms for the rest of the tab's life. The ping stops on
	// every exit; the channel closes ONLY on rejection (this handle is never returned then, so
	// nothing downstream could tear it down) — on success it stays open: it IS the RPC transport.
	try {
		await Promise.race([
			ready.promise,
			new Promise<never>((_, reject) => {
				setTimeout(() => {
					reject(new Error("no db leader after 10s"))
				}, 10_000)
			})
		])
	} catch (e) {
		ch.close()
		throw e
	} finally {
		clearInterval(ping)
	}

	const call =
		(method: keyof StorageApi) =>
		(...args: unknown[]) =>
			new Promise((resolve, reject) => {
				const id = crypto.randomUUID()

				pending.set(id, { resolve, reject })
				ch.postMessage({ kind: "req", id, method, args } satisfies Req)

				setTimeout(() => {
					if (pending.delete(id)) {
						reject(new Error(`db rpc timeout: ${method}`))
					}
				}, 5000)
			})

	const api = Object.fromEntries(STORAGE_METHODS.map(m => [m, call(m)])) as unknown as StorageApi

	return { role: "follower", api }
}
