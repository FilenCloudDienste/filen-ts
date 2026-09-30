import Ionicons from "@expo/vector-icons/Ionicons"
import { useResolveClassNames } from "uniwind"
import View, { CrossGlassContainerView } from "@/components/ui/view"
import { PressableScale } from "@/components/ui/pressables"

// The floating save button of an editable preview, below the header.
const PreviewSaveButton = ({
	onPress,
	enabled,
	top,
	insetRight
}: {
	onPress: () => void
	enabled: boolean
	top: number | null
	insetRight: number
}) => {
	const textPrimary = useResolveClassNames("text-primary")

	return (
		<View
			className="absolute left-0 right-0 bg-transparent z-1000 flex-row items-center justify-end pl-4"
			style={{
				top,
				paddingRight: 16 + insetRight
			}}
		>
			<PressableScale
				className="size-11 items-center justify-center"
				onPress={onPress}
				hitSlop={10}
				enabled={enabled}
				rippleColor="transparent"
			>
				<CrossGlassContainerView className="size-11 flex-row items-center justify-center">
					<Ionicons
						name="save-outline"
						size={20}
						color={textPrimary.color}
					/>
				</CrossGlassContainerView>
			</PressableScale>
		</View>
	)
}

export default PreviewSaveButton
