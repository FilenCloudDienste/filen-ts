import { Switch } from "@/components/ui/switch"
import { Button } from "@/components/ui/button"

interface PreferenceToggleRowProps {
	title: string
	description: string
	checked: boolean
	disabled: boolean
	onCheckedChange: (checked: boolean) => void
}

// A settings card row: title and description on the left, the switch that sets them on the right.
function PreferenceToggleRow({ title, description, checked, disabled, onCheckedChange }: PreferenceToggleRowProps) {
	return (
		<div className="flex items-center justify-between gap-4 py-2 first:pt-0">
			<div className="flex flex-col gap-0.5">
				<p className="text-sm font-medium">{title}</p>
				<p className="text-sm text-muted-foreground">{description}</p>
			</div>
			<Switch
				checked={checked}
				disabled={disabled}
				aria-label={title}
				onCheckedChange={onCheckedChange}
			/>
		</div>
	)
}

interface ResetRowProps {
	title: string
	description: string
	onReset: () => void
}

// A settings card row whose button resets the preference its title names.
function ResetRow({ title, description, onReset }: ResetRowProps) {
	return (
		<div className="flex items-center justify-between gap-4 py-2 last:pb-0">
			<div className="flex flex-col gap-0.5">
				<p className="text-sm font-medium">{title}</p>
				<p className="text-sm text-muted-foreground">{description}</p>
			</div>
			<Button
				type="button"
				variant="outline"
				size="sm"
				onClick={onReset}
			>
				{title}
			</Button>
		</div>
	)
}

export { PreferenceToggleRow, ResetRow }
