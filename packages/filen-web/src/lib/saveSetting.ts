import { toast } from "sonner"
import { i18n } from "@/lib/i18n"
import { log } from "@/lib/log"

// Runs one stored-preference write (Settings rows, the listing's sort, view and hidden-items controls); a
// failure is logged and told with the shared "couldn't be saved" toast. Resolves whether it was stored, so a
// caller confirms (or refetches) only a stored value.
export async function saveSetting(write: () => Promise<void> | void): Promise<boolean> {
	try {
		await write()

		return true
	} catch (e) {
		log.warn("settings", "setting write failed", e instanceof Error ? e.message : e)
		toast.error(i18n.t("settings:settingsDocumentsSaveFailed"))

		return false
	}
}
