import { useId, useState } from "react"
import { useTranslation } from "react-i18next"
import type { AppHelpId } from "@filen/shared/assistant"
import { Switch } from "@/components/ui/switch"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { LoadingState } from "@/components/loadingState"
import { SettingsRow } from "@/features/settings/components/settingsLayout"
import { DisabledReason } from "@/components/ui/tooltipIconButton"

interface PreferenceToggleRowProps {
	title: string
	description: string
	checked: boolean
	disabled: boolean
	// Why the switch is disabled, as its accessible description, only when that reason is worth telling
	// (offline); never for a toggle that is merely in flight.
	disabledReason?: string | undefined
	helpId?: AppHelpId | undefined
	onCheckedChange: (checked: boolean) => void
}

// A settings row whose switch sets the preference its title names.
function PreferenceToggleRow({ title, description, checked, disabled, disabledReason, helpId, onCheckedChange }: PreferenceToggleRowProps) {
	const reasonId = useId()
	const reason = disabled ? disabledReason : undefined

	return (
		<SettingsRow
			label={title}
			description={description}
			helpId={helpId}
		>
			<Switch
				checked={checked}
				disabled={disabled}
				aria-label={title}
				aria-describedby={reason === undefined ? undefined : reasonId}
				onCheckedChange={onCheckedChange}
			/>
			<DisabledReason
				id={reasonId}
				reason={reason}
			/>
		</SettingsRow>
	)
}

interface ResetRowProps {
	title: string
	description: string
	helpId?: AppHelpId | undefined
	onReset: () => void
}

// A settings row whose button resets the preference its title names. The button reads "Reset" and is
// named by the title, so several on one page stay distinguishable to assistive tech.
function ResetRow({ title, description, helpId, onReset }: ResetRowProps) {
	const { t } = useTranslation("common")

	return (
		<SettingsRow
			label={title}
			description={description}
			helpId={helpId}
		>
			<Button
				type="button"
				variant="outline"
				aria-label={title}
				onClick={onReset}
			>
				{t("reset")}
			</Button>
		</SettingsRow>
	)
}

interface SettingsSelectRowProps<V extends string> {
	label: string
	description?: string | undefined
	id: string
	options: readonly { value: V; label: string }[]
	// Undefined while the preference loads; a spinner holds the select's place.
	value: V | undefined
	disabled: boolean
	helpId?: AppHelpId | undefined
	onChange: (value: V) => void
}

// A settings row whose select picks the preference its label names.
function SettingsSelectRow<V extends string>({
	label,
	description,
	id,
	options,
	value,
	disabled,
	helpId,
	onChange
}: SettingsSelectRowProps<V>) {
	return (
		<SettingsRow
			label={label}
			description={description}
			htmlFor={id}
			helpId={helpId}
		>
			{value === undefined ? (
				<LoadingState
					size="sm"
					className="min-h-8 w-36"
				/>
			) : (
				<Select
					items={options}
					value={value}
					disabled={disabled}
					onValueChange={next => {
						if (next !== null) {
							onChange(next)
						}
					}}
				>
					<SelectTrigger
						id={id}
						className="min-w-36"
					>
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
			)}
		</SettingsRow>
	)
}

interface SettingsNumberRowProps {
	label: string
	description?: string | undefined
	id: string
	// Undefined while the preference loads; a spinner holds the input's place.
	value: number | undefined
	min: number
	max: number
	// Shown after the input, e.g. a unit.
	suffix?: string | undefined
	disabled: boolean
	helpId?: AppHelpId | undefined
	onChange: (value: number) => void
}

function parseWhole(text: string, min: number, max: number): number | null {
	if (!/^\d+$/.test(text.trim())) {
		return null
	}

	const value = Number(text.trim())

	return value >= min && value <= max ? value : null
}

// A settings row whose input sets the whole number its label names. A change is committed on Enter or when the input
// loses focus, only when it is a whole number in range and differs; anything else goes back to the stored value.
function SettingsNumberRow({ label, description, id, value, min, max, suffix, disabled, helpId, onChange }: SettingsNumberRowProps) {
	// null while the input shows the stored value.
	const [draft, setDraft] = useState<string | null>(null)
	const parsed = draft === null ? null : parseWhole(draft, min, max)

	function commit(): void {
		if (parsed !== null && parsed !== value) {
			onChange(parsed)
		}

		setDraft(null)
	}

	return (
		<SettingsRow
			label={label}
			description={description}
			htmlFor={id}
			helpId={helpId}
		>
			{value === undefined ? (
				<LoadingState
					size="sm"
					className="min-h-8 w-28"
				/>
			) : (
				<>
					<Input
						id={id}
						inputMode="numeric"
						className="w-28 text-right leading-5 tabular-nums"
						value={draft ?? String(value)}
						disabled={disabled}
						aria-invalid={draft !== null && parsed === null}
						onChange={event => {
							setDraft(event.target.value)
						}}
						onBlur={commit}
						onKeyDown={event => {
							if (event.key === "Enter") {
								event.preventDefault()
								commit()
							} else if (event.key === "Escape") {
								setDraft(null)
							}
						}}
					/>
					{suffix !== undefined && <span className="text-sm text-muted-foreground">{suffix}</span>}
				</>
			)}
		</SettingsRow>
	)
}

export { PreferenceToggleRow, ResetRow, SettingsNumberRow, SettingsSelectRow }
