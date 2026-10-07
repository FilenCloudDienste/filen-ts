// Set when a sign-out starts its wipes and cleared only by the boot that has redone them, so a sign-out
// cut short (the tab closed during a long thumbnail wipe, a crash) still completes on the next start
// instead of leaving decrypted data, or a still-valid session, behind. localStorage, unlike the kv store,
// survives the wipe it guards and is readable before storage opens.
const SIGN_OUT_PENDING_KEY = "filen.signOutPending"

export function readSignOutPending(): boolean {
	try {
		return localStorage.getItem(SIGN_OUT_PENDING_KEY) === "1"
	} catch {
		return false
	}
}

export function writeSignOutPending(pending: boolean): void {
	try {
		if (pending) {
			localStorage.setItem(SIGN_OUT_PENDING_KEY, "1")
		} else {
			localStorage.removeItem(SIGN_OUT_PENDING_KEY)
		}
	} catch {
		// Storage blocked: the sign-out itself still runs; only the resume of a torn one is lost.
	}
}
