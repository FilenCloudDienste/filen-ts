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

export function FavoritedIndicatorInline() {
	const textRed500 = useResolveClassNames("text-red-500")

	return (
		<Ionicons
			name="heart"
			size={12}
			color={textRed500.color as string}
		/>
	)
}

export function OfflineIndicatorInline() {
	const textGreen500 = useResolveClassNames("text-green-500")

	return (
		<Ionicons
			name="download-outline"
			size={12}
			color={textGreen500.color as string}
		/>
	)
}
