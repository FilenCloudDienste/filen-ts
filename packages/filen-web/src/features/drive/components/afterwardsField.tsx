import { useId } from "react"
import { useTranslation } from "react-i18next"
import type { SourceDisposalKind } from "@filen/shared"
import type { ArchiveKey } from "@/lib/i18n"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Label } from "@/components/ui/label"

export type AfterwardsValue = "keep" | SourceDisposalKind

type AfterwardsKind = "compress" | "extract"

interface AfterwardsOption {
	value: AfterwardsValue
	labelKey: ArchiveKey
	hintKey: ArchiveKey
}

// Compress removes the selected items, extract the archive.
const OPTIONS: Record<AfterwardsKind, readonly AfterwardsOption[]> = {
	compress: [
		{ value: "keep", labelKey: "archiveAfterwardsKeep", hintKey: "archiveAfterwardsKeepHint" },
		{ value: "trash", labelKey: "archiveAfterwardsTrash", hintKey: "archiveAfterwardsTrashHint" },
		{ value: "deletePermanently", labelKey: "archiveAfterwardsDelete", hintKey: "archiveAfterwardsDeleteHint" }
	],
	extract: [
		{ value: "keep", labelKey: "archiveAfterwardsKeepArchive", hintKey: "archiveAfterwardsKeepHint" },
		{ value: "trash", labelKey: "archiveAfterwardsTrashArchive", hintKey: "archiveAfterwardsTrashArchiveHint" },
		{ value: "deletePermanently", labelKey: "archiveAfterwardsDeleteArchive", hintKey: "archiveAfterwardsDeleteArchiveHint" }
	]
}

function isAfterwardsValue(value: unknown): value is AfterwardsValue {
	return value === "keep" || value === "trash" || value === "deletePermanently"
}

export interface AfterwardsFieldProps {
	value: AfterwardsValue
	onChange: (value: AfterwardsValue) => void
	// The originals are the selected items (compress) or the archive (extract).
	kind: AfterwardsKind
	disabled?: boolean | undefined
}

// What happens to the originals once the job's result is checked. Radios rather than a select: three
// choices, each with a hint, one of them destructive. The deletion itself is confirmed by the dialog.
export function AfterwardsField({ value, onChange, kind, disabled }: AfterwardsFieldProps) {
	const { t } = useTranslation("archive")
	const id = useId()
	const labelId = `${id}-label`

	return (
		<div className="flex flex-col gap-3">
			<Label id={labelId}>{t("archiveAfterwardsLabel")}</Label>
			<RadioGroup
				aria-labelledby={labelId}
				name={`${kind}-afterwards`}
				value={value}
				disabled={disabled}
				onValueChange={next => {
					if (isAfterwardsValue(next)) {
						onChange(next)
					}
				}}
			>
				{OPTIONS[kind].map(option => {
					const optionId = `${id}-${option.value}`

					return (
						<div
							key={option.value}
							className="flex items-start gap-3"
						>
							<RadioGroupItem
								id={optionId}
								value={option.value}
								aria-describedby={`${optionId}-hint`}
								className="mt-0.5"
							/>
							<div className="flex min-w-0 flex-col gap-1">
								<Label
									htmlFor={optionId}
									className="leading-snug"
								>
									{t(option.labelKey)}
								</Label>
								<p
									id={`${optionId}-hint`}
									className="text-sm text-muted-foreground"
								>
									{t(option.hintKey)}
								</p>
							</div>
						</div>
					)
				})}
			</RadioGroup>
		</div>
	)
}
