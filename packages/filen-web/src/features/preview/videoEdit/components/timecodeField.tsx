import { useId, useState } from "react"
import { useTranslation } from "react-i18next"
import { Input } from "@/components/ui/input"
import { formatTimecode, parseTimecode } from "@/features/preview/videoEdit/lib/timeline.logic"

// A time typed as a timecode ("01:05.25"), committed on Enter or on leaving the field; a typo is said and the field
// goes back to the time it shows. Its own draft only while focused, so the value follows the timeline otherwise.
export function TimecodeField(props: {
	label: string
	value: number
	disabled?: boolean | undefined
	onCommit: (seconds: number) => void
}) {
	const { t } = useTranslation("preview")
	const id = useId()
	const [draft, setDraft] = useState<string | null>(null)
	const [invalid, setInvalid] = useState(false)
	const shown = draft ?? formatTimecode(props.value)

	const commit = (): void => {
		if (draft === null) {
			return
		}

		const seconds = parseTimecode(draft)

		setDraft(null)
		setInvalid(seconds === null)

		if (seconds !== null && Math.abs(seconds - props.value) >= 0.005) {
			props.onCommit(seconds)
		}
	}

	return (
		<div className="flex min-w-0 flex-col gap-1">
			<label
				htmlFor={id}
				className="text-xs text-muted-foreground"
			>
				{props.label}
			</label>
			<Input
				id={id}
				value={shown}
				inputMode="decimal"
				spellCheck={false}
				autoComplete="off"
				disabled={props.disabled}
				aria-invalid={invalid}
				aria-describedby={invalid ? `${id}-error` : undefined}
				className="h-8 font-mono text-xs tabular-nums"
				onChange={event => {
					setDraft(event.target.value)
					setInvalid(false)
				}}
				onBlur={commit}
				onKeyDown={event => {
					if (event.key === "Enter") {
						event.preventDefault()
						commit()
					} else if (event.key === "Escape" && draft !== null) {
						event.preventDefault()
						event.stopPropagation()
						setDraft(null)
					}
				}}
			/>
			{invalid ? (
				<span
					id={`${id}-error`}
					className="text-[11px] text-destructive"
				>
					{t("previewVideoEditTimecodeInvalid")}
				</span>
			) : null}
		</div>
	)
}
