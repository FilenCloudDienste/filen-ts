import { useResolveClassNames } from "uniwind"
import { CrossGlassContainerView } from "@/components/ui/view"
import { PressableScale } from "@/components/ui/pressables"
import Ionicons from "@expo/vector-icons/Ionicons"

const EllipsisMenuTrigger = ({ size = 20 }: { size?: number }) => {
	const textForeground = useResolveClassNames("text-foreground")

	return (
		<CrossGlassContainerView>
			<PressableScale className="size-9 items-center justify-center">
				<Ionicons
					name="ellipsis-horizontal"
					size={size}
					color={textForeground.color}
				/>
			</PressableScale>
		</CrossGlassContainerView>
	)
}

export default EllipsisMenuTrigger
