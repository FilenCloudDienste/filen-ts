import { DEFAULT_OFFICE_AUTOSAVE_DELAY_MS } from "@filen/shared"

// Idle autosave's pause after the last edit before the user chose one (Settings, Office: Autosave delay).
export const AUTOSAVE_IDLE_MS = DEFAULT_OFFICE_AUTOSAVE_DELAY_MS

// E2E builds: the sessionStorage key ("off") a read-only test lane sets so no editor autosaves there.
const E2E_AUTOSAVE_KEY = "filen-e2e-docx-autosave"

function e2eAutosaveOff(): boolean {
	try {
		return sessionStorage.getItem(E2E_AUTOSAVE_KEY) === "off"
	} catch {
		return false
	}
}

// E2E builds only: the lane turned idle autosave off for its page (set before the app loads). Folded away in
// other builds.
export const E2E_AUTOSAVE_OFF: boolean = import.meta.env.VITE_E2E === "1" && e2eAutosaveOff()
