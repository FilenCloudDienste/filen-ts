import { fail } from "../../support.ts"

// A bare Chrome DevTools Protocol client on Node's global WebSocket: a Chromium page target from
// --remote-debugging-port, or a Node main process from --inspect (3.x only; 4.x's fuses remove --inspect). No dependency.

export interface CdpTarget {
	type: string
	url: string
	webSocketDebuggerUrl?: string
}

export interface Cdp {
	send(method: string, params?: Record<string, unknown>): Promise<unknown>
	// Runtime.evaluate by value, promises awaited unless `awaitPromise` is false (a synchronous read never depends on a
	// promise the target may collect); an exception in the target rejects with its description.
	evaluate(expression: string, options?: { awaitPromise?: boolean }): Promise<unknown>
	// Resolves with the params of the next `method` event (Debugger.paused, say), or rejects after `timeoutMs`.
	nextEvent(method: string, timeoutMs: number): Promise<unknown>
	close(): void
}

// The targets an endpoint lists; null while it does not answer yet.
export async function listTargets(port: number): Promise<CdpTarget[] | null> {
	try {
		const response = await fetch(`http://127.0.0.1:${String(port)}/json/list`, { signal: AbortSignal.timeout(5000) })

		return response.ok ? ((await response.json()) as CdpTarget[]) : null
	} catch {
		return null
	}
}

const CALL_TIMEOUT_MS = 30_000

export async function connectCdp(url: string): Promise<Cdp> {
	const socket = new WebSocket(url)
	const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
	const waiting = new Map<string, ((params: unknown) => void)[]>()
	let next = 0

	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true })
		socket.addEventListener("error", () => reject(new Error(`cannot connect to ${url}`)), { once: true })
	})

	socket.addEventListener("message", event => {
		const message = JSON.parse(String(event.data)) as {
			id?: number
			method?: string
			params?: unknown
			result?: unknown
			error?: { message?: string }
		}

		if (message.method !== undefined) {
			const listeners = waiting.get(message.method) ?? []

			waiting.delete(message.method)

			for (const listener of listeners) {
				listener(message.params)
			}

			return
		}

		const call = message.id === undefined ? undefined : pending.get(message.id)

		if (call === undefined || message.id === undefined) {
			return
		}

		pending.delete(message.id)

		if (message.error) {
			call.reject(new Error(message.error.message ?? "CDP error"))
		} else {
			call.resolve(message.result)
		}
	})
	socket.addEventListener("close", () => {
		for (const call of pending.values()) {
			call.reject(new Error("the CDP connection closed"))
		}

		pending.clear()
	})

	const send = (method: string, params: Record<string, unknown> = {}) =>
		new Promise<unknown>((resolve, reject) => {
			const id = ++next
			const timer = setTimeout(() => {
				pending.delete(id)
				reject(new Error(`${method}: no answer in ${String(CALL_TIMEOUT_MS / 1000)} s`))
			}, CALL_TIMEOUT_MS)

			pending.set(id, {
				resolve: value => {
					clearTimeout(timer)
					resolve(value)
				},
				reject: error => {
					clearTimeout(timer)
					reject(error)
				}
			})
			socket.send(JSON.stringify({ id, method, params }))
		})

	return {
		send,
		async evaluate(expression, options = {}) {
			const result = (await send("Runtime.evaluate", {
				expression,
				returnByValue: true,
				awaitPromise: options.awaitPromise ?? true
			})) as {
				result?: { value?: unknown }
				exceptionDetails?: { text?: string; exception?: { description?: string } }
			}

			if (result.exceptionDetails) {
				fail(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "evaluation threw")
			}

			return result.result?.value
		},
		nextEvent(method, timeoutMs) {
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error(`no ${method} in ${String(timeoutMs / 1000)} s`)), timeoutMs)

				waiting.set(method, [
					...(waiting.get(method) ?? []),
					params => {
						clearTimeout(timer)
						resolve(params)
					}
				])
			})
		},
		close() {
			socket.close()
		}
	}
}
