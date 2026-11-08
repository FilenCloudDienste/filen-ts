import { createContext, use } from "react"

// What the user has typed into the password prompt a preview's file asks before it opens, kept for the slot on
// screen. A newer version of the same file shown meanwhile (a row of a listing restored from disk moving on once
// read) remounts the viewer, which asks again: its prompt starts from this, so what was typed is not lost. Held
// only in memory, by the overlay, for as long as the slot is on screen; a check or a dismissal clears it.
export class PasswordDraft {
	#password = ""
	#revealed = false
	#dismissed = false

	get password(): string {
		return this.#password
	}

	get revealed(): boolean {
		return this.#revealed
	}

	get dismissed(): boolean {
		return this.#dismissed
	}

	keep(password: string, revealed: boolean): void {
		this.#password = password
		this.#revealed = revealed
	}

	// The prompt was dismissed (a lock with a button to bring it back) or brought back.
	dismiss(dismissed: boolean): void {
		this.#dismissed = dismissed

		if (dismissed) {
			this.#password = ""
		}
	}
}

// Undefined outside a preview overlay: nothing is kept.
export const PasswordDraftContext = createContext<PasswordDraft | undefined>(undefined)

export function usePasswordDraft(): PasswordDraft | undefined {
	return use(PasswordDraftContext)
}
