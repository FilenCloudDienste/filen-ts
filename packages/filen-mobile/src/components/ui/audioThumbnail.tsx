import { useResolveClassNames } from "uniwind"
import { cn } from "@filen/shared"
import Ionicons from "@expo/vector-icons/Ionicons"
import View from "@/components/ui/view"
import Image from "@/components/ui/image"

export function AudioThumbnail({
	pictureUri,
	active = false,
	recyclingKey,
	className,
	size
}: {
	pictureUri?: string | null
	active?: boolean
	recyclingKey?: string
	className?: string
	size?: number
}) {
	const textForeground = useResolveClassNames("text-foreground")
	const dimension = size ?? 40

	if (pictureUri) {
		return (
			<Image
				className={cn(
					"rounded-lg bg-background-tertiary",
					active ? "border border-blue-500" : "border border-transparent",
					className
				)}
				style={{
					width: dimension,
					height: dimension
				}}
				source={{
					uri: pictureUri
				}}
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
				active ? "border border-blue-500" : "border border-transparent",
				className
			)}
			style={{
				width: dimension,
				height: dimension
			}}
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
