import { Switch } from "@/components/ui/switch"

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

export { PreferenceToggleRow }
