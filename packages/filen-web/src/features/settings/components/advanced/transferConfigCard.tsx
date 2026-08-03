import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { useTransferPreferencesQuery } from "@/features/settings/queries/preferences"
import {
	setTransferPreferences,
	TRANSFER_PERFORMANCE_PRESETS,
	type TransferPerformancePreset,
	type TransferPreferences
} from "@/features/settings/lib/transferConfig"
import type { SettingsKey } from "@/lib/i18n"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Field, FieldContent, FieldLabel, FieldDescription } from "@/components/ui/field"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"

const PRESET_LABEL_KEYS: Record<TransferPerformancePreset, SettingsKey> = {
	batterySaver: "settingsAdvancedPresetBatterySaver",
	balanced: "settingsAdvancedPresetBalanced",
	performance: "settingsAdvancedPresetPerformance",
	maximum: "settingsAdvancedPresetMaximum"
}

// Advanced → transfer performance preset. The wasm client has no live setter for concurrency or
// file-IO memory budget (see transferConfig.ts) and no bandwidth limiter at all — every change here
// only takes effect the next time Filen loads, surfaced as an info toast rather than pretended as
// immediate.
function TransferConfigCard() {
	const { t } = useTranslation("settings")
	const query = useTransferPreferencesQuery()
	const prefs = query.data
	const pending = prefs === undefined

	async function apply(next: TransferPreferences): Promise<void> {
		await setTransferPreferences(next)
		void query.refetch()
		toast.info(t("settingsAdvancedRestartRequired"))
	}

	return (
		<Card>
			<CardHeader>
				<CardTitle>{t("settingsAdvancedTransferTitle")}</CardTitle>
				<CardDescription>{t("settingsAdvancedTransferDescription")}</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				{pending ? (
					<Skeleton className="h-8 w-full rounded-2xl" />
				) : (
					<>
						<Field orientation="horizontal">
							<FieldContent>
								<FieldLabel htmlFor="advanced-transfer-preset">{t("settingsAdvancedTransferPreset")}</FieldLabel>
							</FieldContent>
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
								<SelectTrigger id="advanced-transfer-preset">
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
						</Field>
						<FieldDescription>{t("settingsAdvancedRestartRequired")}</FieldDescription>
					</>
				)}
			</CardContent>
		</Card>
	)
}

export { TransferConfigCard }
