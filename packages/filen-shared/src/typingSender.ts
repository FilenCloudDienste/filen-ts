import { Semaphore } from "./semaphore"

// Send side of realtime chat typing, generic over the platform chat type and SDK call. Throttles "down" so
// a keystroke burst costs one request per window, and fires a single "up" on idle / send / blur / teardown
// only while a "down" is outstanding (the receiver has nothing to clear otherwise).

export type TypingSignal = "down" | "up"

// Well inside the receiver's 10s expiry, so a continuous typist keeps the indicator armed.
export const TYPING_DOWN_THROTTLE_MS = 2_500
// Short of the receiver's 10s expiry, so a real stop lands before its watchdog would guess it.
export const TYPING_IDLE_UP_MS = 3_000

export type TypingSender<C> = {
	// Call on every keystroke while composing.
	signalTyping: (chat: C) => void
	// Call on send / clear / blur / thread teardown.
	signalStopped: (chat: C) => void
}

type TypingSendState = {
	lastDownAt: number
	idleTimer: ReturnType<typeof setTimeout> | undefined
	downActive: boolean
}

export function createTypingSender<C>(options: {
	keyOf: (chat: C) => string
	send: (chat: C, type: TypingSignal) => Promise<void>
	onError: (chat: C, type: TypingSignal, error: unknown) => void
}): TypingSender<C> {
	const { keyOf, send, onError } = options
	const states = new Map<string, TypingSendState>()
	// Serializes sends so an "up" can never overtake the "down" it follows.
	const semaphore = new Semaphore(1)

	const getState = (chat: C): TypingSendState => {
		const key = keyOf(chat)
		let state = states.get(key)

		if (state === undefined) {
			state = { lastDownAt: 0, idleTimer: undefined, downActive: false }
			states.set(key, state)
		}

		return state
	}

	// Fire-and-forget: a dropped signal is never user-visible (the receiver's watchdog covers a lost "up").
	const emit = (chat: C, type: TypingSignal): void => {
		void semaphore
			.acquire()
			.then(async () => {
				try {
					await send(chat, type)
				} finally {
					semaphore.release()
				}
			})
			.catch((e: unknown) => {
				onError(chat, type, e)
			})
	}

	const signalStopped = (chat: C): void => {
		const state = getState(chat)

		if (state.idleTimer !== undefined) {
			clearTimeout(state.idleTimer)
			state.idleTimer = undefined
		}

		// Reset so the first keystroke after a stop emits a "down" immediately.
		state.lastDownAt = 0

		if (!state.downActive) {
			return
		}

		state.downActive = false

		emit(chat, "up")
	}

	const signalTyping = (chat: C): void => {
		const state = getState(chat)
		const now = Date.now()

		if (state.idleTimer !== undefined) {
			clearTimeout(state.idleTimer)
		}

		state.idleTimer = setTimeout(() => {
			signalStopped(chat)
		}, TYPING_IDLE_UP_MS)

		if (now - state.lastDownAt >= TYPING_DOWN_THROTTLE_MS) {
			state.lastDownAt = now
			state.downActive = true

			emit(chat, "down")
		}
	}

	return {
		signalTyping,
		signalStopped
	}
}
