// Where an "API key no longer valid" reply from any SDK call reaches the one check that may sign the user out
// (features/shell/lib/sessionEnded.ts). Kept free of imports: lib/sdk/client.ts calls it for every rejection.

let listener: (() => void) | null = null
let holds = 0
let deferred = false

// The wasm ErrorKind the SDK maps the server's invalid-API-key replies to; it only ever comes from a server answer,
// so being offline never produces it.
function isUnauthenticated(e: unknown): boolean {
	return typeof e === "object" && e !== null && (e as { kind?: unknown }).kind === "Unauthenticated"
}

export function reportSessionSuspect(): void {
	if (holds > 0) {
		deferred = true

		return
	}

	listener?.()
}

// Every rejection of an SDK worker call passes here; only an Unauthenticated one does anything.
export function noteSdkRejection(e: unknown): void {
	if (isUnauthenticated(e)) {
		reportSessionSuspect()
	}
}

// The check itself; returns the unsubscribe.
export function setSessionSuspectListener(next: () => void): () => void {
	listener = next

	return () => {
		if (listener === next) {
			listener = null
		}
	}
}

// While `fn` runs, reports wait: a password change revokes the key calls already in flight were sent with, and a boot
// import may find a dead session on purpose. A report made meanwhile is checked once afterwards.
export async function withSessionCheckHeld<T>(fn: () => Promise<T>): Promise<T> {
	holds++

	try {
		return await fn()
	} finally {
		holds--

		if (holds === 0 && deferred) {
			deferred = false
			listener?.()
		}
	}
}

// Wraps the worker remote so each call's rejection is seen here too; the caller still gets the same promise.
export function watchSessionHealth<T extends object>(remote: T): T {
	return new Proxy(remote, {
		get(target, property, receiver) {
			const value: unknown = Reflect.get(target, property, receiver)

			// Comlink resolves `then` itself, and symbols are its own control keys.
			if (typeof property !== "string" || property === "then" || typeof value !== "function") {
				return value
			}

			return (...args: unknown[]) => {
				const result: unknown = Reflect.apply(value, target, args)

				if (result instanceof Promise) {
					result.catch(noteSdkRejection)
				}

				return result
			}
		}
	})
}
