import { NativeText } from "react-native-boost/runtime"
import { withUniwind } from "uniwind"
import type { TextProps } from "react-native"
import { cn } from "@filen/utils"

const UniwindText = withUniwind(NativeText) as React.FC<TextProps>

export const Text = (props: TextProps) => {
	return (
		<UniwindText
			{...props}
			className={cn("text-foreground", props.className)}
		/>
	)
}

export default Text
