import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { useTransferPreferencesQuery } from "@/features/settings/queries/preferences"
import { setTransferPreferences, type TransferPreferences } from "@/features/settings/lib/transferConfig"
import { TRANSFER_PERFORMANCE_PRESETS, type TransferPerformancePreset } from "@filen/shared"
import type { SettingsKey } from "@/lib/i18n"
import { SettingsSelectRow } from "@/features/settings/components/settingRows"

const PRESET_LABEL_KEYS: Record<TransferPerformancePreset, SettingsKey> = {
	batterySaver: "settingsAdvancedPresetBatterySaver",
	balanced: "settingsAdvancedPresetBalanced",
	performance: "settingsAdvancedPresetPerformance",
	maximum: "settingsAdvancedPresetMaximum"
}

// Advanced → transfer performance preset. The wasm client has no live setter for concurrency or
// file-IO memory budget (see transferConfig.ts) and no bandwidth limiter at all — every change here
// only takes effect the next time Filen loads, said up front in the row and again as an info toast
// rather than pretended as immediate.
function TransferConfigRow() {
	const { t } = useTranslation("settings")
	const query = useTransferPreferencesQuery()
	const prefs = query.data

	// The restart note only for a value that was stored.
	function apply(next: TransferPreferences): void {
		setTransferPreferences(next).then(
			() => {
				void query.refetch()
				toast.info(t("settingsAdvancedRestartRequired"))
			},
			() => {
				toast.error(t("settingsDocumentsSaveFailed"))
			}
		)
	}

	return (
		<SettingsSelectRow
			label={t("settingsAdvancedTransferPreset")}
			description={t("settingsAdvancedRestartRequired")}
			id="advanced-transfer-preset"
			options={TRANSFER_PERFORMANCE_PRESETS.map(preset => ({ value: preset, label: t(PRESET_LABEL_KEYS[preset]) }))}
			value={prefs?.preset}
			disabled={query.isFetching}
			onChange={preset => {
				// The select only renders once prefs loaded.
				if (prefs !== undefined) {
					apply({ ...prefs, preset })
				}
			}}
		/>
	)
}

export { TransferConfigRow }
