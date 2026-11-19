import { E2E_PDF_DETERMINISTIC_KEY } from "@/e2e-hooks/storageKeys"

// E2E builds: a test lane sets E2E_PDF_DETERMINISTIC_KEY to "on" so every PDF export (the editors' File menus, the
// drive's Download as) is deterministic: no creation date, a file identifier from the title, so two exports of
// the same file compare byte for byte.

function e2ePdfDeterministic(): boolean {
	try {
		return sessionStorage.getItem(E2E_PDF_DETERMINISTIC_KEY) === "on"
	} catch {
		return false
	}
}

// E2E builds only (set before the app loads). Folded away in other builds.
export const PDF_DETERMINISTIC: boolean = import.meta.env.VITE_E2E === "1" && e2ePdfDeterministic()
