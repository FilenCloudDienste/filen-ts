import * as Comlink from "comlink"
import { serializeError, deserializeError, type SerializedError } from "@/lib/storage/rpcError"
import DbWorker from "@/workers/db.worker.ts?worker" // matches the sdk worker's own spawn convention (src/lib/sdk/client.ts) — confirmed working in dev + build
import type { StorageApi } from "@/workers/db.worker"
import { createListenerSet } from "@/lib/listenerSet"
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
const leadershipListeners = createListenerSet("db.leader")

export function storageRole(): "leader" | "follower" | null {
	return currentRole
}

// Subscribe to leadership changes (fires on promotion follower→leader). Returns an unsubscribe fn.
export const onStorageLeadershipChange = leadershipListeners.subscribe

// Whether another tab has ever reached this one's db storage: a follower pings and reads through the leader
// before it can ask any outbox for state, and a promoted leader had older tabs queued ahead. Never reset.
let peerSeen = false

export function storageHasPeers(): boolean {
	return peerSeen
}

function setStorageRole(role: "leader" | "follower"): void {
	if (currentRole === role) {
		return
	}

	currentRole = role
	leadershipListeners.emit()
}

// Transport: the shared CHANNEL carries only the hellos. Each leader serves requests on its own channel,
// named by the id it announces, and answers each follower on that follower's own channel, so no request or
// response is cloned into a tab it is not for. A new id in "leader-ready" means a new leader: a follower
// re-posts its pending requests there.
interface Req {
	kind: "req"
	id: string
	tab: string
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
type Hello = { kind: "leader-ready"; leader: string } | { kind: "leader?" }

function requestChannelName(leader: string): string {
	return `${CHANNEL}:req:${leader}`
}

function responseChannelName(tab: string): string {
	return `${CHANNEL}:res:${tab}`
}

const STORAGE_METHODS = [
	"open",
	"kvGet",
	"kvSet",
	"kvDelete",
	"kvKeys",
	"kvEntries",
	"kvEntriesPage",
	"kvDeletePrefix",
	"kvDeleteIfAt",
	"kvPrefixBytes",
	"vacuum",
	"wipe",
	"noteIndexStamps",
	"noteIndexPut",
	"noteIndexDelete",
	"noteIndexPrune",
	"noteIndexSearch",
	"noteIndexClear",
	"dumpLogs"
] as const satisfies readonly (keyof StorageApi)[]

const RPC_TIMEOUT_MS = 5000

// A full VACUUM holds the db worker for as long as the database takes to rebuild, which can be well past the default.
const RPC_TIMEOUT_OVERRIDES: Partial<Record<keyof StorageApi, number>> = { vacuum: 600_000 }

// A follower's response channel stays open this long after its last answer, so a burst of calls reuses it.
const RESPONSE_CHANNEL_IDLE_MS = 30_000

function invoke(api: StorageApi, method: keyof StorageApi, args: unknown[]): Promise<unknown> {
	return (api[method] as (...a: unknown[]) => Promise<unknown>)(...args)
}

// Spin up this tab's own db worker, open OPFS, and start serving — the work a tab does the moment it holds
// the lock, whether it was the FIRST leader or a promoted follower. Returns the direct worker api. A thrown
// open() (see db.worker.ts) terminates the worker, so a failed attempt keeps no sqlite module or pool files,
// and propagates so the caller releases the lock and the next queued tab is granted instead of everyone hanging.
async function becomeLeader(): Promise<StorageApi> {
	const worker = new DbWorker()
	const remote = Comlink.wrap<StorageApi>(worker)

	try {
		await remote.open()
	} catch (e) {
		remote[Comlink.releaseProxy]()
		worker.terminate()

		throw e
	}

	const leader = crypto.randomUUID()
	const hello = new BroadcastChannel(CHANNEL)
	const requests = new BroadcastChannel(requestChannelName(leader))
	const responders = new Map<string, { ch: BroadcastChannel; inFlight: number; idle: ReturnType<typeof setTimeout> | undefined }>()

	const respond = async (msg: Req): Promise<void> => {
		let responder = responders.get(msg.tab)

		if (responder === undefined) {
			responder = { ch: new BroadcastChannel(responseChannelName(msg.tab)), inFlight: 0, idle: undefined }
			responders.set(msg.tab, responder)
		}

		responder.inFlight++
		clearTimeout(responder.idle)

		try {
			responder.ch.postMessage(await serve(msg, remote))
		} finally {
			responder.inFlight--

			if (responder.inFlight === 0) {
				const idle = responder

				idle.idle = setTimeout(() => {
					idle.ch.close()
					responders.delete(msg.tab)
				}, RESPONSE_CHANNEL_IDLE_MS)
			}
		}
	}

	hello.onmessage = (ev: MessageEvent<Hello>) => {
		if (ev.data.kind === "leader?") {
			peerSeen = true
			hello.postMessage({ kind: "leader-ready", leader } satisfies Hello)
		}
	}
	requests.onmessage = (ev: MessageEvent<Req>) => {
		peerSeen = true
		void respond(ev.data)
	}
	hello.postMessage({ kind: "leader-ready", leader } satisfies Hello)

	// Comlink.Remote<StorageApi> is structurally StorageApi here (every method already returns a Promise).
	return remote
}

// Role is decided by the LOCK GRANT (deterministic) — never by racing a timer against open().
//
// When the lock is taken, this tab both handshakes with the leader over the channel AND queues a
// BLOCKING request on the same lock, and whichever settles first decides the role. A live leader
// answers the handshake: this tab is a follower, and the queued request is its promotion — granted
// when the leader releases (tab close/crash), it becomes a leader and MUTATES the already-returned
// handle in place (every kv caller re-reads `.api` per call, see adapter.ts). A holder that is only
// on its way out — the previous document of a navigation or reload, which can keep the lock after
// the new one starts — never answers; the lock is granted first instead and this tab leads straight
// away, rather than waiting out the handshake for a leader that no longer exists.
export function acquireStorage(): Promise<StorageHandle> {
	return new Promise((resolve, reject) => {
		// `.catch(reject)` matters: a rejection inside a lock callback reaches navigator.locks.request()'s
		// own returned promise, and without it the outer Promise here would hang forever instead of
		// surfacing the error.
		const granted = navigator.locks.request(LOCK, { ifAvailable: true }, async lock => {
			if (lock === null) {
				contendForLeadership(resolve, reject)

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

function contendForLeadership(resolve: (handle: StorageHandle) => void, reject: (reason: unknown) => void): void {
	const handshake = new AbortController()
	const queue = new AbortController()
	let follower: Follower | null = null
	let promoting = false
	let settled = false

	const promoted = navigator.locks.request(LOCK, { signal: queue.signal }, async () => {
		// The old leader is gone: hold this tab's calls until its own leader is up instead of posting them
		// to a channel nobody serves.
		promoting = true
		follower?.suspend()

		const api = await becomeLeader()

		if (follower) {
			peerSeen = true
			follower.handle.role = "leader"
			follower.handOver(api)
			follower.handle.api = api
		} else {
			settled = true
			handshake.abort()
			resolve({ role: "leader", api })
		}

		setStorageRole("leader")

		return new Promise<never>(() => undefined) // held for the tab's lifetime; chains to the next queued tab on death
	})

	// A failed promotion (e.g. OPFS open() throws) releases the lock so the next queued tab is tried.
	// Before the handshake settled, nothing else can answer this tab: fail its storage. After it, the calls
	// held for the promotion fail with its error and this tab stays a follower; it follows whichever tab
	// leads next once that one announces itself.
	void promoted.catch((e: unknown) => {
		if (queue.signal.aborted) {
			return
		}

		if (!settled) {
			settled = true
			handshake.abort()
			reject(e)

			return
		}

		follower?.resume(e instanceof Error ? e : new Error(String(e)))
		log.error("db.leader", "promotion failed", e)
	})

	followerHandle(handshake.signal).then(
		link => {
			if (settled) {
				link.close()

				return
			}

			settled = true
			follower = link

			if (promoting) {
				link.suspend()
			}

			setStorageRole("follower")
			resolve(link.handle)
		},
		(e: unknown) => {
			if (settled) {
				return
			}

			// This tab's storage has failed; it must not take the lock later and lead unseen.
			settled = true
			queue.abort()
			reject(e)
		}
	)
}

async function serve(msg: Req, remote: Comlink.Remote<StorageApi>): Promise<Res> {
	try {
		return { kind: "res", id: msg.id, ok: true, value: await invoke(remote, msg.method, msg.args) }
	} catch (e) {
		log.error("db.leader", e)

		return { kind: "res", id: msg.id, ok: false, error: serializeError(e instanceof Error ? e : new Error(String(e))) }
	}
}

interface Follower {
	handle: StorageHandle
	// Promotion started: hold new and pending calls, without timeouts, until handOver or resume.
	suspend(): void
	// Promotion done: run the held calls on the tab's own api in the order they were made and close the follower's channels.
	handOver(api: StorageApi): void
	// Promotion failed: fail the held calls and go back to following.
	resume(error: Error): void
	close(): void
}

interface PendingCall {
	method: keyof StorageApi
	args: unknown[]
	resolve: (v: unknown) => void
	reject: (e: Error) => void
	timer: ReturnType<typeof setTimeout> | undefined
}

async function followerHandle(signal: AbortSignal): Promise<Follower> {
	const tab = crypto.randomUUID()
	const hello = new BroadcastChannel(CHANNEL)
	const pending = new Map<string, PendingCall>()
	let leader: string | null = null
	let requests: BroadcastChannel | null = null
	let responses: BroadcastChannel | null = null
	let held = false
	let direct: StorageApi | null = null

	const ready = Promise.withResolvers<undefined>()

	const send = (id: string, call: PendingCall): void => {
		if (leader === null) {
			return
		}

		requests ??= new BroadcastChannel(requestChannelName(leader))
		requests.postMessage({ kind: "req", id, tab, method: call.method, args: call.args } satisfies Req)
		clearTimeout(call.timer)
		call.timer = setTimeout(() => {
			if (pending.delete(id)) {
				call.reject(new Error(`db rpc timeout: ${call.method}`))
			}
		}, RPC_TIMEOUT_OVERRIDES[call.method] ?? RPC_TIMEOUT_MS)
	}

	const close = (): void => {
		hello.close()
		requests?.close()
		responses?.close()
		requests = null
		responses = null
	}

	hello.onmessage = (ev: MessageEvent<Hello>) => {
		if (ev.data.kind !== "leader-ready" || held || ev.data.leader === leader) {
			return
		}

		// A new leader (the old one died, or this is the handshake): anything still unanswered goes to it.
		leader = ev.data.leader
		requests?.close()
		requests = null

		for (const [id, call] of pending) {
			send(id, call)
		}

		ready.resolve(undefined)
	}

	// The leader announces itself only once, on taking the lock, so ask now; the interval is only the retry.
	hello.postMessage({ kind: "leader?" } satisfies Hello)

	const ping = setInterval(() => {
		hello.postMessage({ kind: "leader?" } satisfies Hello)
	}, 250)

	// Teardown must hang off THIS race, not off `ready` — on the 10s no-leader path the rejection
	// comes from the race's own timer while `ready` (settled only by a leader-ready message) stays
	// pending forever, so a `ready.promise.finally(...)` hook would never fire and the ping interval
	// would keep posting `leader?` every 250ms for the rest of the tab's life. The ping stops on
	// every exit; the channel closes on rejection (this handle is never returned then, so nothing
	// downstream could tear it down). The 10s deadline is cleared on every exit too.
	let deadline: ReturnType<typeof setTimeout> | undefined

	try {
		await Promise.race([
			ready.promise,
			new Promise<never>((_, reject) => {
				deadline = setTimeout(() => {
					reject(new Error("no db leader after 10s"))
				}, 10_000)

				// Aborted when this tab took the lock itself: nothing will answer, so stop waiting.
				signal.addEventListener(
					"abort",
					() => {
						reject(new Error("db leader handshake aborted"))
					},
					{ once: true }
				)
			})
		])
	} catch (e) {
		close()
		throw e
	} finally {
		clearInterval(ping)
		clearTimeout(deadline)
	}

	// The tab's own new leader also answers the handshake, possibly just before the abort lands.
	if (signal.aborted) {
		close()
		throw new Error("db leader handshake aborted")
	}

	responses = new BroadcastChannel(responseChannelName(tab))
	responses.onmessage = (ev: MessageEvent<Res>) => {
		const call = pending.get(ev.data.id)

		if (!call) {
			return // already timed out
		}

		clearTimeout(call.timer)
		pending.delete(ev.data.id)

		if (ev.data.ok) {
			call.resolve(ev.data.value)
		} else {
			call.reject(ev.data.error ? deserializeError(ev.data.error) : new Error("db rpc failed"))
		}
	}

	const call =
		(method: keyof StorageApi) =>
		(...args: unknown[]): Promise<unknown> => {
			// A caller still holding this api after the promotion goes straight to the tab's own worker.
			if (direct !== null) {
				return invoke(direct, method, args)
			}

			return new Promise((resolve, reject) => {
				const id = crypto.randomUUID()
				const entry: PendingCall = { method, args, resolve, reject, timer: undefined }

				pending.set(id, entry)

				if (!held) {
					send(id, entry)
				}
			})
		}

	const handle: StorageHandle = {
		role: "follower",
		api: Object.fromEntries(STORAGE_METHODS.map(m => [m, call(m)])) as unknown as StorageApi
	}

	return {
		handle,
		suspend: () => {
			held = true

			for (const entry of pending.values()) {
				clearTimeout(entry.timer)
				entry.timer = undefined
			}
		},
		// A call the dead leader ran but never answered runs again here. Every method tolerates that: writes and
		// deletes are idempotent, kvDeleteIfAt only reports fewer keys (its callers drop just those from memory),
		// and wipe/vacuum repeat on an already wiped or compacted database.
		handOver: api => {
			direct = api
			close()

			const calls = [...pending.values()]

			pending.clear()

			for (const entry of calls) {
				void invoke(api, entry.method, entry.args).then(entry.resolve, entry.reject)
			}
		},
		resume: error => {
			held = false

			const calls = [...pending.values()]

			pending.clear()

			for (const entry of calls) {
				entry.reject(error)
			}
		},
		close
	}
}
