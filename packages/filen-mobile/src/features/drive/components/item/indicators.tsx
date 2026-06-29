import View from "@/components/ui/view"
import Ionicons from "@expo/vector-icons/Ionicons"
import { useResolveClassNames } from "uniwind"

export function FavoritedIndicator() {
	const textRed500 = useResolveClassNames("text-red-500")

	return (
		<View className="bg-transparent flex-row items-center justify-center absolute bottom-1 -right-2.5 z-10">
			<View className="bg-background-tertiary rounded-full p-0.5 flex-row items-center justify-center">
				<Ionicons
					name="heart"
					size={14}
					color={textRed500.color}
				/>
			</View>
		</View>
	)
}

export function OfflineIndicator() {
	const textGreen500 = useResolveClassNames("text-green-500")

	return (
		<View className="bg-transparent flex-row items-center justify-center absolute bottom-1 -left-2.5 z-10">
			<View className="bg-background-tertiary rounded-full p-0.5 flex-row items-center justify-center">
				<Ionicons
					name="download-outline"
					size={14}
					color={textGreen500.color}
				/>
			</View>
		</View>
	)
}

// Card variants for the grid: absolute overlays positioned INSIDE the card's rounded, overflow-hidden
// bounds (positive offsets — unlike the list's corner variants above, which sit just outside the
// thumbnail via negative offsets and would be clipped here). Mirrors the photos grid's on-cell badges.
export function OfflineIndicatorCard() {
	const textGreen500 = useResolveClassNames("text-green-500")

	return (
		<View className="bg-transparent flex-row items-center justify-center absolute bottom-1.5 left-1.5 z-10">
			<View className="bg-background-tertiary rounded-full p-0.5 flex-row items-center justify-center">
				<Ionicons
					name="download-outline"
					size={13}
					color={textGreen500.color}
				/>
			</View>
		</View>
	)
}

export function FavoritedIndicatorCard() {
	const textRed500 = useResolveClassNames("text-red-500")

	return (
		<View className="bg-transparent flex-row items-center justify-center absolute bottom-1.5 right-1.5 z-10">
			<View className="bg-background-tertiary rounded-full p-0.5 flex-row items-center justify-center">
				<Ionicons
					name="heart"
					size={13}
					color={textRed500.color}
				/>
			</View>
		</View>
	)
}
