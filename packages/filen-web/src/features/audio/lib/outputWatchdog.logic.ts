// Detects an AudioContext that stopped rendering while the engine wants sound: a suspended or interrupted state
// nobody asked for, or a clock that stands still while the element keeps playing (WebKit can do that in the
// background, which plays routed media as silence). One resume is tried; if it does not help, or a second stall
// follows soon, the output degrades for the session.

const STALL_WINDOW_MS = 2_000
const STALL_ELEMENT_ADVANCE_MS = 1_500
const STALL_CONTEXT_ADVANCE_SECONDS = 0.1
const RECOVERY_MS = 1_000
const REPEAT_STALL_MS = 60_000

export type ContextState = "running" | "suspended" | "interrupted" | "closed"

export interface WatchdogSample {
	wallMs: number
	contextSeconds: number
	elementMs: number
	contextState: ContextState
	// The engine is playing (not paused, not loading).
	wantPlaying: boolean
	// The output suspended the context itself (idle while paused).
	selfSuspended: boolean
}

export interface WatchdogState {
	window: { wallMs: number; contextSeconds: number; elementMs: number } | null
	// A resume was asked for at `wallMs`, with the context clock at `contextSeconds`.
	recovering: { wallMs: number; contextSeconds: number } | null
	lastStallMs: number | null
}

export type WatchdogAction = "ok" | "resume" | "degrade"

export const INITIAL_WATCHDOG_STATE: WatchdogState = { window: null, recovering: null, lastStallMs: null }

function windowAt(sample: WatchdogSample): WatchdogState["window"] {
	return { wallMs: sample.wallMs, contextSeconds: sample.contextSeconds, elementMs: sample.elementMs }
}

export function watchdogStep(state: WatchdogState, sample: WatchdogSample): { state: WatchdogState; action: WatchdogAction } {
	if (!sample.wantPlaying || sample.selfSuspended || sample.contextState === "closed") {
		return { state: { window: null, recovering: null, lastStallMs: state.lastStallMs }, action: "ok" }
	}

	if (state.recovering !== null) {
		const recovered =
			sample.contextState === "running" && sample.contextSeconds - state.recovering.contextSeconds >= STALL_CONTEXT_ADVANCE_SECONDS

		if (recovered) {
			return { state: { window: windowAt(sample), recovering: null, lastStallMs: state.lastStallMs }, action: "ok" }
		}

		return sample.wallMs - state.recovering.wallMs > RECOVERY_MS ? { state, action: "degrade" } : { state, action: "ok" }
	}

	if (sample.contextState !== "running") {
		return {
			state: {
				window: null,
				recovering: { wallMs: sample.wallMs, contextSeconds: sample.contextSeconds },
				lastStallMs: state.lastStallMs
			},
			action: "resume"
		}
	}

	const window = state.window

	if (window === null || sample.elementMs < window.elementMs) {
		return { state: { ...state, window: windowAt(sample) }, action: "ok" }
	}

	if (sample.wallMs - window.wallMs < STALL_WINDOW_MS) {
		return { state, action: "ok" }
	}

	const stalled =
		sample.elementMs - window.elementMs > STALL_ELEMENT_ADVANCE_MS &&
		sample.contextSeconds - window.contextSeconds < STALL_CONTEXT_ADVANCE_SECONDS

	if (!stalled) {
		return { state: { ...state, window: windowAt(sample) }, action: "ok" }
	}

	if (state.lastStallMs !== null && sample.wallMs - state.lastStallMs < REPEAT_STALL_MS) {
		return { state, action: "degrade" }
	}

	return {
		state: { window: null, recovering: { wallMs: sample.wallMs, contextSeconds: sample.contextSeconds }, lastStallMs: sample.wallMs },
		action: "resume"
	}
}
