import { Checkbox as ExpoCheckbox } from "expo-checkbox"
import { withUniwind, useResolveClassNames } from "uniwind"
import { memo } from "react"
import { cn } from "@filen/utils"

export const UniwindCheckbox = memo(withUniwind(ExpoCheckbox) as React.FC<React.ComponentProps<typeof ExpoCheckbox>>)

export const Checkbox = memo((props: React.ComponentProps<typeof ExpoCheckbox> & React.RefAttributes<typeof ExpoCheckbox>) => {
	const textPrimary = useResolveClassNames("text-primary")

	return (
		<UniwindCheckbox
			{...props}
			color={props.color ?? (props.value ? textPrimary.color : undefined)}
			className={cn("rounded-full size-5 border border-border", props.className)}
		/>
	)
})

export default Checkbox
