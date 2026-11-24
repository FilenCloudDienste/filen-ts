import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { saveSetting } from "@/lib/saveSetting"
import { useTransferPreferencesQuery } from "@/features/settings/queries/preferences"
import {
	buildJsClientConfig,
	rememberAppliedTransferConfig,
	setTransferPreferences,
	type TransferPreferences
} from "@/features/settings/lib/transferConfig"
import { forgetSwClientHandoff } from "@/features/drive/lib/saveDownload"
import { sdkApi } from "@/lib/sdk/client"
import { TRANSFER_PERFORMANCE_PRESETS } from "@filen/shared"
import { SettingsSelectRow } from "@/features/settings/components/settingRows"
import { PRESET_LABEL_KEYS } from "@/features/settings/lib/presetLabels"

// Advanced → transfer performance preset, applied at once (see transferConfig.ts); the wasm client has no
// bandwidth limiter at all.
function TransferConfigRow() {
	const { t } = useTranslation("settings")
	const query = useTransferPreferencesQuery()
	const prefs = query.data

	// Applied only once stored, so the running client never differs from what the next load builds.
	async function apply(next: TransferPreferences): Promise<void> {
		if (!(await saveSetting(() => setTransferPreferences(next)))) {
			return
		}

		void query.refetch()

		const config = buildJsClientConfig(next)

		rememberAppliedTransferConfig(config)
		forgetSwClientHandoff()

		try {
			await sdkApi.applyTransferConfig(config)
		} catch {
			toast.error(t("settingsAdvancedTransferApplyFailed"))
		}
	}

	return (
		<SettingsSelectRow
			label={t("settingsAdvancedTransferPreset")}
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
