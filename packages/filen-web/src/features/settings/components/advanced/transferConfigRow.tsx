import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { useTransferPreferencesQuery } from "@/features/settings/queries/preferences"
import { setTransferPreferences, type TransferPreferences } from "@/features/settings/lib/transferConfig"
import { TRANSFER_PERFORMANCE_PRESETS, type TransferPerformancePreset } from "@filen/shared"
import type { SettingsKey } from "@/lib/i18n"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { LoadingState } from "@/components/loadingState"
import { SettingsRow } from "@/features/settings/components/settingsLayout"

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

	async function apply(next: TransferPreferences): Promise<void> {
		await setTransferPreferences(next)
		void query.refetch()
		toast.info(t("settingsAdvancedRestartRequired"))
	}

	return (
		<SettingsRow
			label={t("settingsAdvancedTransferPreset")}
			description={t("settingsAdvancedRestartRequired")}
			htmlFor="advanced-transfer-preset"
		>
			{prefs === undefined ? (
				<LoadingState
					size="sm"
					className="min-h-8 w-36"
				/>
			) : (
				<Select
					items={TRANSFER_PERFORMANCE_PRESETS.map(preset => ({ value: preset, label: t(PRESET_LABEL_KEYS[preset]) }))}
					value={prefs.preset}
					disabled={query.isFetching}
					onValueChange={value => {
						if (value !== null) {
							void apply({ ...prefs, preset: value })
						}
					}}
				>
					<SelectTrigger
						id="advanced-transfer-preset"
						className="min-w-36"
					>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectGroup>
							{TRANSFER_PERFORMANCE_PRESETS.map(preset => (
								<SelectItem
									key={preset}
									value={preset}
								>
									{t(PRESET_LABEL_KEYS[preset])}
								</SelectItem>
							))}
						</SelectGroup>
					</SelectContent>
				</Select>
			)}
		</SettingsRow>
	)
}

export { TransferConfigRow }
