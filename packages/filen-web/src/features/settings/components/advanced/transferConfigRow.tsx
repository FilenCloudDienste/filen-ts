import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { saveSetting } from "@/lib/saveSetting"
import { useTransferPreferencesQuery } from "@/features/settings/queries/preferences"
import { setTransferPreferences, type TransferPreferences } from "@/features/settings/lib/transferConfig"
import { TRANSFER_PERFORMANCE_PRESETS } from "@filen/shared"
import { SettingsSelectRow } from "@/features/settings/components/settingRows"
import { PRESET_LABEL_KEYS } from "@/features/settings/lib/presetLabels"

// Advanced → transfer performance preset. A change takes effect the next time Filen loads (see
// transferConfig.ts), said up front in the row and again as an info toast rather than pretended as
// immediate; the wasm client has no bandwidth limiter at all.
function TransferConfigRow() {
	const { t } = useTranslation("settings")
	const query = useTransferPreferencesQuery()
	const prefs = query.data

	// The restart note only for a value that was stored.
	async function apply(next: TransferPreferences): Promise<void> {
		if (await saveSetting(() => setTransferPreferences(next))) {
			void query.refetch()
			toast.info(t("settingsAdvancedRestartRequired"))
		}
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
					void apply({ ...prefs, preset })
				}
			}}
		/>
	)
}

export { TransferConfigRow }
