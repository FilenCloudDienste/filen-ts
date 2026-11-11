// Quitting asks first while the native host runs transfers, which the quit stops. Not while the page holds something
// (its unload guard asks), an update installs (its confirm was answered) or the user agreed to this quit already.
export function shouldConfirmQuit(state: {
	unloadHolds: number
	nativeTransfers: number
	installingUpdate: boolean
	confirmed: boolean
}): boolean {
	return state.nativeTransfers > 0 && state.unloadHolds === 0 && !state.installingUpdate && !state.confirmed
}
