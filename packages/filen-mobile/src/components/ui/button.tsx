import { type ButtonProps, Button as RNButton } from "react-native"
import { useResolveClassNames } from "uniwind"
import useIsOnline from "@/hooks/useIsOnline"

const Button = (
	props: Omit<ButtonProps, "title"> & {
		children: string
		requiresOnline?: boolean
	}
) => {
	const { requiresOnline, ...buttonProps } = props
	const bgPrimary = useResolveClassNames("bg-primary")
	const isOnline = useIsOnline()

	return (
		<RNButton
			{...buttonProps}
			title={props.children}
			color={props.color ?? (bgPrimary.backgroundColor as string)}
			disabled={props.disabled === true || (requiresOnline === true && !isOnline)}
		/>
	)
}

export default Button
