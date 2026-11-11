// A quit while a native drag runs (Linux's nested loop and macOS's drag tracking still run IPC and the tray) waits for
// the drag to return, then quits again. Never longer than this: a drag whose end never arrives would hold the quit
// until the sessions' watchdog; past it the quit goes on and will-quit ends the drag.
export const QUIT_DRAG_WAIT_MS = 5000

export interface QuitAfterDrag {
	// From before-quit: true when the quit has to wait (the caller prevents it).
	defer(): boolean
	// The quit was cancelled (the page's unload guard): any wait is abandoned and the next quit is judged afresh.
	reset(): void
}

export function createQuitAfterDrag(deps: { running(): boolean; idle(): Promise<void>; quit(): void }): QuitAfterDrag {
	let phase: "idle" | "waiting" | "timedOut" = "idle"
	let generation = 0
	let timer: ReturnType<typeof setTimeout> | undefined

	function settle(own: number, timedOut: boolean): void {
		if (own !== generation) {
			return
		}

		generation++
		clearTimeout(timer)
		timer = undefined
		phase = timedOut ? "timedOut" : "idle"
		deps.quit()
	}

	return {
		defer: () => {
			if (phase === "timedOut") {
				phase = "idle"

				return false
			}

			if (phase === "waiting") {
				return true
			}

			if (!deps.running()) {
				return false
			}

			const own = generation

			phase = "waiting"
			timer = setTimeout(() => {
				settle(own, true)
			}, QUIT_DRAG_WAIT_MS)
			void deps.idle().then(() => {
				settle(own, false)
			})

			return true
		},
		reset: () => {
			generation++
			clearTimeout(timer)
			timer = undefined
			phase = "idle"
		}
	}
}
