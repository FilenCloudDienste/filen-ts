// Every SDK worker call this page has made and not seen settle, for the e2e failure diagnostics: a
// listing stuck loading with no request on the wire is a call stalled inside the worker, and a stalled
// worker cannot be asked, so this is counted on the calling side. Installed only in VITE_E2E builds
// (lib/sdk/client.ts); the import is dead-code-eliminated from a normal one.
let pending: Map<number, { method: string; startedAt: number }> | null = null
let nextId = 0

export function trackSdkCalls<T extends object>(remote: T): T {
	const calls = new Map<number, { method: string; startedAt: number }>()

	pending = calls

	return new Proxy(remote, {
		get(target, property, receiver) {
			const value: unknown = Reflect.get(target, property, receiver)

			// Comlink resolves `then` itself, and symbols are its own control keys.
			if (typeof property !== "string" || property === "then" || typeof value !== "function") {
				return value
			}

			return (...args: unknown[]) => {
				const id = nextId++

				calls.set(id, { method: property, startedAt: Date.now() })

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

// Oldest first.
export function pendingSdkCalls(): { method: string; ageMs: number }[] {
	const now = Date.now()

	return [...(pending?.values() ?? [])]
		.sort((a, b) => a.startedAt - b.startedAt)
		.map(({ method, startedAt }) => ({ method, ageMs: now - startedAt }))
}
