import type { TransferPerformanceChoice } from "@filen/shared"
import type { SettingsKey } from "@/lib/i18n"

// The transfer preset names as every settings surface shows them: Advanced (this page's client) and Desktop › Speed
// (the shell's sync and transfer clients).
export const PRESET_LABEL_KEYS: Record<TransferPerformanceChoice, SettingsKey> = {
	slowConnection: "settingsAdvancedPresetSlowConnection",
	batterySaver: "settingsAdvancedPresetBatterySaver",
	balanced: "settingsAdvancedPresetBalanced",
	performance: "settingsAdvancedPresetPerformance",
	maximum: "settingsAdvancedPresetMaximum",
	custom: "settingsAdvancedPresetCustom"
}
