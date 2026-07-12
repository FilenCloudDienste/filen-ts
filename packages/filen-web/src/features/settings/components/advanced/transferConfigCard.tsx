import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { useTransferPreferencesQuery } from "@/features/settings/queries/preferences"
import {
	setTransferPreferences,
	TRANSFER_PERFORMANCE_PRESETS,
	TRANSFER_BANDWIDTH_PRESETS_KBPS,
	kbpsToMbLabel,
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

// Bandwidth Select values are strings ("unlimited" sentinel + one per TRANSFER_BANDWIDTH_PRESETS_KBPS
// entry) — Base UI's generic Select works with any comparable value, but every other Select in this
// app (theme/expiration/preset) already uses plain strings, so bandwidth follows the same idiom
// rather than introducing number|null values into this one control.
const UNLIMITED = "unlimited"

function bandwidthToSelectValue(kbps: number | null): string {
	return kbps === null ? UNLIMITED : String(kbps)
}

function selectValueToBandwidth(value: string): number | null {
	return value === UNLIMITED ? null : Number(value)
}

interface BandwidthFieldProps {
	id: string
	labelKey: SettingsKey
	kbps: number | null
	disabled: boolean
	onChange: (kbps: number | null) => void
}

function BandwidthField({ id, labelKey, kbps, disabled, onChange }: BandwidthFieldProps) {
	const { t } = useTranslation("settings")
	const options = [
		{ value: UNLIMITED, label: t("settingsAdvancedUnlimited") },
		...TRANSFER_BANDWIDTH_PRESETS_KBPS.map(preset => ({ value: String(preset), label: kbpsToMbLabel(preset) }))
	]

	return (
		<Field orientation="horizontal">
			<FieldContent>
				<FieldLabel htmlFor={id}>{t(labelKey)}</FieldLabel>
			</FieldContent>
			<Select
				items={options}
				value={bandwidthToSelectValue(kbps)}
				disabled={disabled}
				onValueChange={value => {
					if (value !== null) {
						onChange(selectValueToBandwidth(value))
					}
				}}
			>
				<SelectTrigger id={id}>
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					<SelectGroup>
						{options.map(option => (
							<SelectItem
								key={option.value}
								value={option.value}
							>
								{option.label}
							</SelectItem>
						))}
					</SelectGroup>
				</SelectContent>
			</Select>
		</Field>
	)
}

// Advanced → bandwidth caps + transfer performance preset. Scoped explicitly to THIS browser tab's
// own uploads/downloads (settingsAdvancedTransferDescription) — the wasm client has no live setter
// for any of these (see transferConfig.ts's own comment), so every change here only takes effect the
// next time Filen loads, surfaced as an info toast rather than pretended as immediate.
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
					<>
						<Skeleton className="h-8 w-full rounded-2xl" />
						<Skeleton className="h-8 w-full rounded-2xl" />
						<Skeleton className="h-8 w-full rounded-2xl" />
					</>
				) : (
					<>
						<BandwidthField
							id="advanced-upload-limit"
							labelKey="settingsAdvancedUploadLimit"
							kbps={prefs.uploadKbps}
							disabled={query.isFetching}
							onChange={kbps => {
								void apply({ ...prefs, uploadKbps: kbps })
							}}
						/>
						<BandwidthField
							id="advanced-download-limit"
							labelKey="settingsAdvancedDownloadLimit"
							kbps={prefs.downloadKbps}
							disabled={query.isFetching}
							onChange={kbps => {
								void apply({ ...prefs, downloadKbps: kbps })
							}}
						/>
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
