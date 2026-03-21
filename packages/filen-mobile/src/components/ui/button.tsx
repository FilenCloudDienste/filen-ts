import { type ButtonProps, Button as RNButton } from "react-native"
import { useResolveClassNames } from "uniwind"
import { memo } from "@/lib/memo"

export const Button = memo(
	(
		props: Omit<ButtonProps, "title"> & {
			children: string
			title?: string
		}
	) => {
		const bgPrimary = useResolveClassNames("bg-primary")

		return (
			<RNButton
				{...props}
				title={props.title ?? props.children}
				color={props.color ?? (bgPrimary.backgroundColor as string)}
			/>
		)
	}
)

export default Button
