import * as Comlink from "comlink"
import type { SocketEvent, MaybeEncrypted } from "@filen/sdk-rs"
import { sdkApi } from "@/lib/sdk/client"
import { log } from "@/lib/log"

// The main-thread half of the realtime socket bridge — the FIRST socket wiring in filen-web, kept
// generic so drive/chats reuse it later; the note handlers live in features/notes, never here. One
// subscription for the whole app (started by the authed shell, torn down on logout). Domain modules
// register a handler per top-level event.type; unknown/unregistered types are ignored silently.

// A handler receives the narrowed event for the exact `type` it registered under.
export type SocketHandlerFor<T extends SocketEvent["type"]> = (event: Extract<SocketEvent, { type: T }>) => void

// Internally every handler is stored under this widened shape (dispatch only ever calls one with the
// event whose `type` it was registered under, so the narrowing the caller declared always holds).
type StoredHandler = (event: SocketEvent) => void

// Keyed by top-level event.type ("note" | "drive" | "chat" | "contact" | "general" | "authSuccess" …).
// A Set so a domain can register more than one handler and the same handler can't double-register.
const registry: Map<string, Set<StoredHandler>> = new Map<string, Set<StoredHandler>>()

// Register a handler for one event category; returns an unregister fn. The Extract-typed signature
// means a "note" handler is handed `{ type: "note" } & NoteSocketEvent` with no cast at the call site.
export function registerSocketHandler<T extends SocketEvent["type"]>(type: T, handler: SocketHandlerFor<T>): () => void {
	const stored = handler as StoredHandler

	let handlers = registry.get(type)

	if (handlers === undefined) {
		handlers = new Set<StoredHandler>()

		registry.set(type, handlers)
	}

	handlers.add(stored)

	return () => {
		const set = registry.get(type)

		if (set === undefined) {
			return
		}

		set.delete(stored)

		if (set.size === 0) {
			registry.delete(type)
		}
	}
}

// The single entry point the worker's proxied callback invokes for every event. Fans out to the
// handlers registered for that category; a throwing handler is logged and never aborts the fan-out or
// the socket. An unregistered category (e.g. "drive" before the drive wave) is a silent no-op.
function dispatch(event: SocketEvent): void {
	const handlers = registry.get(event.type)

	if (handlers === undefined) {
		return
	}

	for (const handler of handlers) {
		try {
			handler(event)
		} catch (e) {
			log.error("socket", "handler threw", event.type, e)
		}
	}
}

// Decrypted-only guard for a MaybeEncrypted payload field (content/title on note events, name/mime on
// drive events, …). A payload can legitimately arrive still-encrypted (a key the session can't yet
// resolve); the Encrypted arm is logged and skipped — returning undefined — never thrown. Generic so
// every domain's handlers share this one guard.
export function decryptedOrSkip<T>(value: MaybeEncrypted<T>, context: string): T | undefined {
	if ("Decrypted" in value) {
		return value.Decrypted
	}

	log.warn("socket", "received encrypted payload, skipping", context)

	return undefined
}

class SocketBridge {
	private started = false
	// The Comlink.proxy handed to the worker. Held so it is not GC'd while the worker's ListenerHandle
	// still references it; a plain wrapping fn, same idiom as the upload/download onProgress proxies.
	private proxied: StoredHandler | null = null

	// Idempotent — a second start() while already subscribed is a no-op (the shell mounts once, but a
	// StrictMode double-effect must not double-subscribe). `started` flips BEFORE the await so a
	// synchronous second call can't slip a second subscribe through the round trip.
	public async start(): Promise<void> {
		if (this.started) {
			return
		}

		this.started = true
		this.proxied = Comlink.proxy(dispatch)

		try {
			await sdkApi.subscribeToSocket(this.proxied)
		} catch (e) {
			// Roll back so a later start() can retry; the worker frees any half-made handle on the next
			// subscribe/logout.
			this.started = false
			this.proxied = null

			log.error("socket", "subscribeToSocket failed", e)
		}
	}

	// Wired into logout BEFORE the local wipe (mirrors notesSync.cancel). Releases the worker's handle,
	// then drops the held proxy so it can be collected — the worker has freed its ListenerHandle and will
	// not invoke the callback again. Safe to call when never started.
	public async stop(): Promise<void> {
		if (!this.started) {
			return
		}

		this.started = false
		this.proxied = null

		try {
			await sdkApi.unsubscribeFromSocket()
		} catch (e) {
			log.error("socket", "unsubscribeFromSocket failed", e)
		}
	}
}

export const socketBridge = new SocketBridge()
