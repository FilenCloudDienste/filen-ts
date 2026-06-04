import View from "@/components/ui/view"
import { cn } from "@filen/utils"
import Ionicons from "@expo/vector-icons/Ionicons"
import { useVideoPlayer, VideoView } from "expo-video"
import { PressableScale } from "@/components/ui/pressables"
import { type InternalLinkData, openAttachmentPreview } from "@/features/chats/utils"

export const VideoAttachment = ({
	url,
	name,
	layout,
	linked,
	fromSelf
}: {
	url: string
	name: string
	layout: {
		width: number
		height: number
	}
	linked?: InternalLinkData
	fromSelf: boolean
}) => {
	const player = useVideoPlayer(url, p => {
		p.loop = false
		p.staysActiveInBackground = false
	})

	const maxWH = layout.width * 0.75 - 32 - 24

	const style = {
		width: maxWH,
		height: maxWH,
		borderRadius: 16
	}

	return (
		<PressableScale
			className={cn(
				"items-center justify-center rounded-2xl overflow-hidden flex-row",
				fromSelf ? "bg-blue-600" : "bg-background-tertiary"
			)}
			style={style}
			onPress={() => {
				openAttachmentPreview({
					linked,
					url,
					name
				})
			}}
		>
			<View className="absolute z-100 bg-transparent w-full h-full items-center justify-center">
				<Ionicons
					name="play-circle-outline"
					size={48}
					color="#ffffff"
				/>
			</View>
			<VideoView
				style={style}
				player={player}
				contentFit="cover"
				nativeControls={false}
				allowsPictureInPicture={false}
				focusable={false}
				fullscreenOptions={{
					enable: false
				}}
			/>
		</PressableScale>
	)
}

export default VideoAttachment
