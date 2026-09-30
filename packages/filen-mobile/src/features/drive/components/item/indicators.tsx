import View from "@/components/ui/view"
import Ionicons from "@expo/vector-icons/Ionicons"
import { useResolveClassNames } from "uniwind"

// Favorited / offline badge overlaid on a thumbnail. Position, size and background differ per
// surface: the drive list sits just outside the thumbnail (negative offsets), the drive grid card
// and the photos grid sit inside their rounded, overflow-hidden bounds.
export function IndicatorBadge({
	type,
	size,
	positionClassName,
	bgClassName
}: {
	type: "favorited" | "offline"
	size: number
	positionClassName: string
	bgClassName: string
}) {
	const textColor = useResolveClassNames(type === "favorited" ? "text-red-500" : "text-green-500")

	return (
		<View className={`bg-transparent flex-row items-center justify-center absolute z-10 ${positionClassName}`}>
			<View className={`${bgClassName} rounded-full p-0.5 flex-row items-center justify-center`}>
				<Ionicons
					name={type === "favorited" ? "heart" : "download-outline"}
					size={size}
					color={textColor.color}
				/>
			</View>
		</View>
	)
}
