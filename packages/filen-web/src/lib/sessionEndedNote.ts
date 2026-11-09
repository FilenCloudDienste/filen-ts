// Set when the server stopped accepting this browser's session and the app signed out for it, so the sign-in screen
// can say why, in this tab and in the tabs the sign-out reloads. Cleared by the next sign-in; an old one is ignored.
const SESSION_ENDED_KEY = "filen.sessionEnded"

const SHOW_FOR_MS = 60 * 60 * 1000

export function writeSessionEndedNote(now: number = Date.now()): void {
	try {
		localStorage.setItem(SESSION_ENDED_KEY, String(now))
	} catch {
		// Storage blocked: the sign-in screen shows without the note.
	}
}

export function readSessionEndedNote(now: number = Date.now()): boolean {
	try {
		const at = Number(localStorage.getItem(SESSION_ENDED_KEY) ?? Number.NaN)

		return Number.isFinite(at) && now >= at && now - at < SHOW_FOR_MS
	} catch {
		return false
	}
}

export function clearSessionEndedNote(): void {
	try {
		localStorage.removeItem(SESSION_ENDED_KEY)
	} catch {
		// Storage blocked: nothing was stored either.
	}
}
