// Whether this browser held a session at the last write: a boolean the boot splash reads synchronously to
// weight its phases, since the session itself lives in OPFS and is unreadable before storage opens. Never
// account data; a wrong value only misjudges the bar, and the next resume corrects it.
const SIGNED_IN_HINT_KEY = "filen.signedInHint"

export function readSignedInHint(): boolean {
	try {
		return localStorage.getItem(SIGNED_IN_HINT_KEY) === "1"
	} catch {
		return false
	}
}

export function writeSignedInHint(signedIn: boolean): void {
	try {
		if (signedIn) {
			localStorage.setItem(SIGNED_IN_HINT_KEY, "1")
		} else {
			localStorage.removeItem(SIGNED_IN_HINT_KEY)
		}
	} catch {
		// Storage blocked: the splash falls back to the signed-out weighting.
	}
}
