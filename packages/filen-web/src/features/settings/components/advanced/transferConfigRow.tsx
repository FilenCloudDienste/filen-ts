import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { saveSetting } from "@/lib/saveSetting"
import { useTransferPreferencesQuery } from "@/features/settings/queries/preferences"
import {
	buildJsClientConfig,
	customConcurrencyOf,
	rememberAppliedTransferConfig,
	setTransferPreferences,
	type TransferPreferences
} from "@/features/settings/lib/transferConfig"
import { forgetSwClientHandoff } from "@/features/drive/lib/saveDownload"
import { sdkApi } from "@/lib/sdk/client"
import { DESKTOP_WEB_CUSTOM_CONCURRENCY_MAX, TRANSFER_PERFORMANCE_CHOICES } from "@filen/shared"
import { SettingsNumberRow, SettingsSelectRow } from "@/features/settings/components/settingRows"
import { PRESET_LABEL_KEYS } from "@/features/settings/lib/presetLabels"

// Advanced → transfer performance preset, or a custom chunk count in a row under it while Custom is chosen, applied at once (see transferConfig.ts); the wasm client has no
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
		<>
			<SettingsSelectRow
				label={t("settingsAdvancedTransferPreset")}
				id="advanced-transfer-preset"
				options={TRANSFER_PERFORMANCE_CHOICES.map(preset => ({ value: preset, label: t(PRESET_LABEL_KEYS[preset]) }))}
				value={prefs?.preset}
				disabled={query.isFetching}
				onChange={preset => {
					// The select only renders once prefs loaded.
					if (prefs !== undefined) {
						void apply({ ...prefs, preset })
					}
				}}
			/>
			{prefs?.preset === "custom" ? (
				<SettingsNumberRow
					label={t("settingsAdvancedTransferChunks")}
					description={t("settingsAdvancedTransferChunksDescription")}
					id="advanced-transfer-chunks"
					helpId="transferChunks"
					value={customConcurrencyOf(prefs)}
					min={1}
					max={DESKTOP_WEB_CUSTOM_CONCURRENCY_MAX}
					disabled={query.isFetching}
					onChange={customConcurrency => {
						void apply({ ...prefs, customConcurrency })
					}}
				/>
			) : null}
		</>
	)
}

export { TransferConfigRow }
