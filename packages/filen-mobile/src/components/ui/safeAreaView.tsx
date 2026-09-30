import { useSafeAreaInsets } from "react-native-safe-area-context"
import View from "@/components/ui/view"
import { cn } from "@filen/shared"
import type { ViewProps } from "react-native"

const SafeAreaView = ({
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

const SCREEN_BODY_EDGES: ("left" | "right")[] = ["left", "right"]

// Screen body under a native header: the header owns the top inset, lists/scroll views the bottom.
export const ScreenBody = ({ className, ...props }: { children: React.ReactNode } & ViewProps) => {
	return (
		<SafeAreaView
			{...props}
			edges={SCREEN_BODY_EDGES}
			className={cn("bg-background-secondary", className)}
		/>
	)
}

export default SafeAreaView
