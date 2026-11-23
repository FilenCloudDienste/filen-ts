// Every SDK worker call this page has made and not seen settle, for the e2e failure diagnostics: a
// listing stuck loading with no request on the wire is a call stalled inside the worker, and a stalled
// worker cannot be asked, so this is counted on the calling side. Installed only in VITE_E2E builds
// (lib/sdk/client.ts); the import is dead-code-eliminated from a normal one. The other workers' calls
// (the PDF engine's, the signer's) are counted the same way, apart, by worker.

interface PendingCall {
	readonly method: string
	readonly startedAt: number
}

let sdkCalls: Map<number, PendingCall> | null = null
const workerCalls = new Map<number, PendingCall>()
let nextId = 0

// A proxy of `remote` whose method calls are in `calls`, as `name(method)`, until they settle.
function tracked<T extends object>(remote: T, calls: Map<number, PendingCall>, name: (method: string) => string): T {
	return new Proxy(remote, {
		get(target, property, receiver) {
			const value: unknown = Reflect.get(target, property, receiver)

			// Comlink resolves `then` itself, and symbols are its own control keys.
			if (typeof property !== "string" || property === "then" || typeof value !== "function") {
				return value
			}

			return (...args: unknown[]) => {
				const id = nextId++

				calls.set(id, { method: name(property), startedAt: Date.now() })

				const result: unknown = Reflect.apply(value, target, args)

				if (result instanceof Promise) {
					return result.finally(() => {
						calls.delete(id)
					})
				}

				calls.delete(id)

				return result
			}
		}
	})
}

export function trackSdkCalls<T extends object>(remote: T): T {
	const calls = new Map<number, PendingCall>()

	sdkCalls = calls

	return tracked(remote, calls, method => method)
}

// `worker` names the worker in the report: "pdf-engine open".
export function trackWorkerCalls<T extends object>(remote: T, worker: string): T {
	return tracked(remote, workerCalls, method => `${worker} ${method}`)
}

// Oldest first.
function pending(calls: Iterable<PendingCall>): { method: string; ageMs: number }[] {
	const now = Date.now()

	return [...calls].sort((a, b) => a.startedAt - b.startedAt).map(({ method, startedAt }) => ({ method, ageMs: now - startedAt }))
}

export function pendingSdkCalls(): { method: string; ageMs: number }[] {
	return pending(sdkCalls?.values() ?? [])
}

export function pendingWorkerCalls(): { method: string; ageMs: number }[] {
	return pending(workerCalls.values())
}
