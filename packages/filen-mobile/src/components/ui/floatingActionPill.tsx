import { CrossGlassContainerView } from "@/components/ui/view"
import Text from "@/components/ui/text"
import { PressableScale } from "@/components/ui/pressables"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { cn } from "@filen/shared"

// Bottom-right confirm action of the picker screens.
const FloatingActionPill = ({
	label,
	enabled,
	onPress,
	testID
}: {
	label: string
	enabled: boolean
	onPress: () => void
	testID?: string
}) => {
	const insets = useSafeAreaInsets()

	return (
		<PressableScale
			testID={testID}
			onPress={onPress}
			className="absolute right-4"
			enabled={enabled}
			style={{
				bottom: insets.bottom
			}}
		>
			<CrossGlassContainerView
				className={cn("min-h-12 min-w-12 px-4 flex-row items-center justify-center", !enabled && "opacity-50")}
			>
				<Text className="font-bold text-blue-500">{label}</Text>
			</CrossGlassContainerView>
		</PressableScale>
	)
}

export default FloatingActionPill
