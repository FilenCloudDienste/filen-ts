import { toast } from "sonner"
import type { OfficeSettingKey, OfficeSettingsValues } from "@filen/shared"
import { saveOfficeSetting } from "@/features/office/lib/officeSettings"
import { i18n } from "@/lib/i18n"
import { log } from "@/lib/log"

// One synced office setting written from the Office page: shown at once, the shared "couldn't be saved" toast when the
// upload fails (the change stays held and goes with the next save).
export function saveSyncedOfficeSetting<K extends OfficeSettingKey>(key: K, value: OfficeSettingsValues[K]): void {
	saveOfficeSetting(key, value).catch((error: unknown) => {
		log.warn("office", "office setting not saved", { key, error })
		toast.error(i18n.t("settings:settingsDocumentsSaveFailed"))
	})
}
