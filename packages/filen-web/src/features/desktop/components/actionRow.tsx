import { useId, useState, type ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { SettingsRow } from "@/features/settings/components/settingsLayout"

// A settings row whose one button runs a shell call, spinning (in place of its `icon`) while it does. The
// button is named by its visible `action` and described by the row label.
export function ActionRow({
	label,
	description,
	action,
	disabled,
	variant,
	icon,
	run
}: {
	label: string
	description?: string | undefined
	action: string
	disabled?: boolean
	variant?: "outline" | "destructive"
	icon?: ReactNode
	run: () => Promise<unknown>
}) {
	const [running, setRunning] = useState(false)
	const labelId = useId()

	return (
		<SettingsRow
			label={label}
			labelId={labelId}
			description={description}
		>
			<Button
				variant={variant ?? "outline"}
				aria-describedby={labelId}
				disabled={running || disabled === true}
				onClick={() => {
					setRunning(true)
					void run().finally(() => {
						setRunning(false)
					})
				}}
			>
				{running ? <Spinner data-icon="inline-start" /> : (icon ?? null)}
				{action}
			</Button>
		</SettingsRow>
	)
}
