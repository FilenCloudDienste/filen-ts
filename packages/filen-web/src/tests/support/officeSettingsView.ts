import { OFFICE_SETTINGS_DEFAULTS } from "@filen/shared"
import type { OfficeSettingsView } from "@/features/office/lib/officeSettings"

// What useOfficeSettings returns once the file was read: every setting at its default unless given. A test may wait
// a shorter autosave pause than the setting offers (real timers).
export function officeSettingsView(
	change: Partial<Omit<OfficeSettingsView, "autosaveDelayMs">> & { autosaveDelayMs?: number } = {}
): OfficeSettingsView {
	const view: Omit<OfficeSettingsView, "autosaveDelayMs"> & { autosaveDelayMs: number } = {
		...OFFICE_SETTINGS_DEFAULTS,
		loaded: true,
		settled: true,
		...change
	}

	return view as OfficeSettingsView
}
