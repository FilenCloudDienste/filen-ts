import { NativeText } from "react-native-boost/runtime"
import { withUniwind } from "uniwind"
import type { TextProps } from "react-native"
import { memo } from "react"
import { cn } from "@filen/utils"

const UniwindText = memo(withUniwind(NativeText) as React.FC<TextProps>)

export const Text = memo((props: TextProps) => {
	return (
		<UniwindText
			{...props}
			className={cn("text-foreground", props.className)}
		/>
	)
})

export default Text
