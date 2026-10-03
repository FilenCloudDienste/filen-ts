import { Fragment } from "react"
import { useTranslation } from "react-i18next"
import type { ArchiveKey } from "@/lib/i18n"
import { isFormatChoiceId, type FormatChoice, type FormatChoiceId, type FormatGroup } from "@/features/drive/lib/archiveFormats"
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectSeparator,
	SelectTrigger,
	SelectValue
} from "@/components/ui/select"

const GROUPS: readonly { group: FormatGroup; labelKey: ArchiveKey }[] = [
	{ group: "common", labelKey: "archiveFormatGroupCommon" },
	{ group: "more", labelKey: "archiveFormatGroupMore" },
	{ group: "single", labelKey: "archiveFormatGroupSingle" }
]

export interface ArchiveFormatSelectProps {
	id: string
	value: FormatChoiceId
	// The formats the selection can take, in catalogue order.
	choices: readonly FormatChoice[]
	// Whether the codec memory runs the format at all; one that can't stays listed, disabled.
	isRunnable: (choice: FormatChoiceId) => boolean
	invalid?: boolean | undefined
	disabled?: boolean | undefined
	onChange: (choice: FormatChoiceId) => void
}

// Every format, grouped, each with a one-line hint; the closed select shows the name alone.
export function ArchiveFormatSelect({ id, value, choices, isRunnable, invalid, disabled, onChange }: ArchiveFormatSelectProps) {
	const { t } = useTranslation("archive")
	const groups = GROUPS.map(entry => ({ ...entry, choices: choices.filter(choice => choice.group === entry.group) })).filter(
		entry => entry.choices.length > 0
	)

	return (
		<Select
			items={choices.map(choice => ({ value: choice.id, label: t(choice.labelKey) }))}
			value={value}
			disabled={disabled}
			onValueChange={next => {
				if (next !== null && isFormatChoiceId(next)) {
					onChange(next)
				}
			}}
		>
			<SelectTrigger
				id={id}
				aria-invalid={invalid === true ? true : undefined}
				className="w-full"
			>
				<SelectValue />
			</SelectTrigger>
			<SelectContent className="max-h-80">
				{groups.map((entry, index) => (
					<Fragment key={entry.group}>
						{index > 0 ? <SelectSeparator /> : null}
						<SelectGroup>
							<SelectLabel>{t(entry.labelKey)}</SelectLabel>
							{entry.choices.map(choice => {
								const runnable = isRunnable(choice.id)

								return (
									<SelectItem
										key={choice.id}
										value={choice.id}
										disabled={!runnable}
									>
										<span className="flex min-w-0 flex-col gap-0.5">
											<span>
												{t(choice.labelKey)}{" "}
												<span className="text-muted-foreground">{choice.displayExtension}</span>
											</span>
											<span className="text-xs whitespace-normal text-muted-foreground">
												{runnable ? t(choice.hintKey) : t("archiveFormatUnavailable")}
											</span>
										</span>
									</SelectItem>
								)
							})}
						</SelectGroup>
					</Fragment>
				))}
			</SelectContent>
		</Select>
	)
}
