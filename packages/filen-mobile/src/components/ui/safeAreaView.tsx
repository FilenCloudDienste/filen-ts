import { useSafeAreaInsets } from "react-native-safe-area-context"
import { memo } from "react"
import View from "@/components/ui/view"
import { cn } from "@filen/utils"
import type { ViewProps } from "react-native"

const SafeAreaView = memo(
	({
		children,
		edges = ["bottom", "top", "left", "right"],
		...props
	}: {
		children: React.ReactNode
		edges?: ("top" | "bottom" | "left" | "right")[]
	} & ViewProps) => {
		const insets = useSafeAreaInsets()

		return (
			<View
				{...props}
				className={cn("flex-1", props.className)}
				style={[
					{
						paddingTop: edges.includes("top") ? insets.top : 0,
						paddingBottom: edges.includes("bottom") ? insets.bottom : 0,
						paddingLeft: edges.includes("left") ? insets.left : 0,
						paddingRight: edges.includes("right") ? insets.right : 0,
						flex: 1
					},
					...(props.style ? [props.style] : [])
				]}
			>
				{children}
			</View>
		)
	}
)

export default SafeAreaView
