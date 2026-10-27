// The presenter view's timer: time spent presenting, paused and resumed, reset to zero. A plain value (React state)
// over the caller's clock in ms (performance.now()), so the view reads it once per second and nothing ticks between.

export interface ShowTimer {
	// Elapsed ms banked while paused.
	readonly banked: number
	// When the running stretch began; undefined while paused.
	readonly since: number | undefined
}

export function startShowTimer(now: number): ShowTimer {
	return { banked: 0, since: now }
}

export function timerElapsed(timer: ShowTimer, now: number): number {
	return timer.banked + (timer.since === undefined ? 0 : Math.max(0, now - timer.since))
}

export function pauseTimer(timer: ShowTimer, now: number): ShowTimer {
	return timer.since === undefined ? timer : { banked: timerElapsed(timer, now), since: undefined }
}

export function resumeTimer(timer: ShowTimer, now: number): ShowTimer {
	return timer.since === undefined ? { banked: timer.banked, since: now } : timer
}

export function resetTimer(timer: ShowTimer, now: number): ShowTimer {
	return { banked: 0, since: timer.since === undefined ? undefined : now }
}

// h:mm:ss, or m:ss under an hour.
export function formatElapsed(ms: number): string {
	const total = Math.floor(Math.max(0, ms) / 1000)
	const hours = Math.floor(total / 3600)
	const minutes = Math.floor((total % 3600) / 60)
	const seconds = String(total % 60).padStart(2, "0")

	return hours > 0 ? `${String(hours)}:${String(minutes).padStart(2, "0")}:${seconds}` : `${String(minutes)}:${seconds}`
}
