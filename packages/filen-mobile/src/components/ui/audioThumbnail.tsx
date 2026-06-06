import { useResolveClassNames } from "uniwind"
import { cn } from "@filen/utils"
import Ionicons from "@expo/vector-icons/Ionicons"
import View from "@/components/ui/view"
import Image from "@/components/ui/image"

export function AudioThumbnail({
	pictureUri,
	size = 40,
	active = false,
	recyclingKey
}: {
	pictureUri?: string | null
	size?: number
	active?: boolean
	recyclingKey?: string
}) {
	const textForeground = useResolveClassNames("text-foreground")

	if (pictureUri) {
		return (
			<Image
				className={cn("rounded-lg bg-background-tertiary", active ? "border border-blue-500" : "border border-transparent")}
				style={{ width: size, height: size }}
				source={{ uri: pictureUri }}
				contentFit="contain"
				cachePolicy="disk"
				recyclingKey={recyclingKey}
			/>
		)
	}

	return (
		<View
			className={cn(
				"bg-background-tertiary rounded-lg flex-row items-center justify-center",
				active ? "border border-blue-500" : "border border-transparent"
			)}
			style={{ width: size, height: size }}
		>
			<Ionicons
				name="musical-note"
				size={16}
				color={textForeground.color}
			/>
		</View>
	)
}

export default AudioThumbnail
