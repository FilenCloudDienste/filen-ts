import { useTranslation } from "react-i18next"
import { Switch } from "@/components/ui/switch"
import { Button } from "@/components/ui/button"
import { SettingsRow } from "@/features/settings/components/settingsLayout"

interface PreferenceToggleRowProps {
	title: string
	description: string
	checked: boolean
	disabled: boolean
	// Native tooltip saying why the switch is disabled, only when that reason is worth telling (offline);
	// never for a toggle that is merely in flight.
	disabledReason?: string | undefined
	onCheckedChange: (checked: boolean) => void
}

// A settings row whose switch sets the preference its title names.
function PreferenceToggleRow({ title, description, checked, disabled, disabledReason, onCheckedChange }: PreferenceToggleRowProps) {
	return (
		<SettingsRow
			label={title}
			description={description}
		>
			<Switch
				checked={checked}
				disabled={disabled}
				aria-label={title}
				title={disabledReason}
				onCheckedChange={onCheckedChange}
			/>
		</SettingsRow>
	)
}

interface ResetRowProps {
	title: string
	description: string
	onReset: () => void
}

// A settings row whose button resets the preference its title names. The button reads "Reset" and is
// named by the title, so several on one page stay distinguishable to assistive tech.
function ResetRow({ title, description, onReset }: ResetRowProps) {
	const { t } = useTranslation("common")

	return (
		<SettingsRow
			label={title}
			description={description}
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

export { PreferenceToggleRow, ResetRow }
