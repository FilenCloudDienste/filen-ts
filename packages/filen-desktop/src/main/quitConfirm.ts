// Quitting asks first while the native host runs transfers, which the quit stops. Not while the page holds something
// (its unload guard asks), an update installs (its confirm was answered), the user agreed to this quit already or the
// OS ends the session (log out, restart, shut down), which a confirm would hold up or cancel.
export function shouldConfirmQuit(state: {
	unloadHolds: number
	nativeTransfers: number
	installingUpdate: boolean
	confirmed: boolean
	sessionEnding: boolean
}): boolean {
	return state.nativeTransfers > 0 && state.unloadHolds === 0 && !state.installingUpdate && !state.confirmed && !state.sessionEnding
}

// The page's unload guard asks the user, except where shouldConfirmQuit would not either.
export function unloadGuardAsks(state: { installingUpdate: boolean; sessionEnding: boolean }): boolean {
	return !state.installingUpdate && !state.sessionEnding
}

interface ShutdownSource {
	on(event: "shutdown", listener: () => void): unknown
}

interface SessionEndSource {
	on(event: "session-end", listener: () => void): unknown
}

// The OS session ends: powerMonitor's shutdown on macOS and Linux, a window's session-end on Windows. Either way it
// ends regardless, so nothing may ask the user from then on. `onEnd` runs once, with the event that came first.
export function createSessionEnd(onEnd: (source: "shutdown" | "session-end") => void): {
	ending: () => boolean
	watchPowerMonitor: (powerMonitor: ShutdownSource) => void
	watchWindow: (window: SessionEndSource) => void
} {
	let ending = false
	const end = (source: "shutdown" | "session-end"): void => {
		if (!ending) {
			ending = true
			onEnd(source)
		}
	}

	return {
		ending: () => ending,
		watchPowerMonitor: powerMonitor => {
			powerMonitor.on("shutdown", () => {
				end("shutdown")
			})
		},
		watchWindow: window => {
			window.on("session-end", () => {
				end("session-end")
			})
		}
	}
}
