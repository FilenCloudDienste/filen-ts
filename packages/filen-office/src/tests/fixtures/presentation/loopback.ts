import type { PresentationEndpoint } from "../../../dom/presentation/engine"
import {
	transferablesOf,
	type FromPresentationWorker,
	type PresentationArgs,
	type PresentationEvent,
	type PresentationMethod,
	type PresentationValue,
	type ToPresentationWorker
} from "../../../dom/presentation/protocol"
import type { PresentationRefusal } from "../../../core/presentation/model"

// An in-thread stand-in for a worker boundary: every message is structured-cloned with its transferables moved,
// as postMessage does, and delivered on a later microtask, so what arrives is what a worker would receive.

type Listener = (event: { readonly data: unknown }) => void

export interface PageEnd {
	post(message: ToPresentationWorker): void
	onMessage(listener: (message: FromPresentationWorker) => void): void
}

export interface Loopback {
	readonly worker: PresentationEndpoint
	readonly page: PageEnd
	// Every message as it crossed, in order.
	readonly toWorker: ToPresentationWorker[]
	readonly fromWorker: FromPresentationWorker[]
}

function cross<T extends ToPresentationWorker | FromPresentationWorker>(message: T): T {
	const options = { transfer: transferablesOf(message) } as unknown as Parameters<typeof structuredClone>[1]

	return structuredClone(message, options)
}

export function loopback(): Loopback {
	const workerListeners = new Set<Listener>()
	const pageListeners: ((message: FromPresentationWorker) => void)[] = []
	const toWorker: ToPresentationWorker[] = []
	const fromWorker: FromPresentationWorker[] = []

	return {
		toWorker,
		fromWorker,
		worker: {
			postMessage(message) {
				const crossed = cross(message)

				void Promise.resolve().then(() => {
					fromWorker.push(crossed)

					for (const listener of pageListeners) listener(crossed)
				})
			},
			addEventListener(_type, listener) {
				workerListeners.add(listener)
			},
			removeEventListener(_type, listener) {
				workerListeners.delete(listener)
			}
		},
		page: {
			post(message) {
				const crossed = cross(message)

				void Promise.resolve().then(() => {
					toWorker.push(crossed)

					for (const listener of workerListeners) listener({ data: crossed })
				})
			},
			onMessage(listener) {
				pageListeners.push(listener)
			}
		}
	}
}

export class CallRefused extends Error {
	readonly reason: PresentationRefusal

	constructor(reason: PresentationRefusal, message: string) {
		super(message)
		this.reason = reason
	}
}

// The page's side of one session over a loopback: calls by id, events in order.
export class LoopbackSession {
	readonly events: PresentationEvent[] = []
	private next = 1
	private readonly waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>()
	private readonly eventWaiters: ((event: PresentationEvent) => void)[] = []

	private readonly page: PageEnd
	readonly s: number

	constructor(page: PageEnd, s: number) {
		this.page = page
		this.s = s
		page.onMessage(message => {
			if (message.s !== this.s) return

			if (message.t === "event") {
				this.events.push(message.event)

				for (const waiter of this.eventWaiters.splice(0)) waiter(message.event)

				return
			}

			const waiter = this.waiting.get(message.id)

			if (waiter === undefined) return

			this.waiting.delete(message.id)

			if (message.t === "result") waiter.resolve(message.value)
			else waiter.reject(new CallRefused(message.reason, message.message))
		})
	}

	nextEvent(): Promise<PresentationEvent> {
		return new Promise(resolve => this.eventWaiters.push(resolve))
	}

	call<M extends PresentationMethod>(
		method: M,
		...args: PresentationArgs<M>
	): { readonly id: number; readonly answer: Promise<PresentationValue<M>> } {
		const id = this.next++
		const answer = new Promise<PresentationValue<M>>((resolve, reject) => {
			this.waiting.set(id, { resolve: value => resolve(value as PresentationValue<M>), reject })
		})

		this.page.post({ t: "call", s: this.s, id, method, args } as ToPresentationWorker)

		return { id, answer }
	}
}
