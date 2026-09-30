import { router } from "@/lib/router"
import { ActivityIndicator } from "react-native"
import audio, { useAudioLoading, useAudioPlaying, useAudioQueue } from "@/features/audio/audio"
import View from "@/components/ui/view"
import Text from "@/components/ui/text"
import { PressableScale } from "@/components/ui/pressables"
import { useResolveClassNames } from "uniwind"
import Ionicons from "@expo/vector-icons/Ionicons"
import AudioThumbnail from "@/components/ui/audioThumbnail"
import useNowPlayingDisplay from "@/features/audio/hooks/useNowPlayingDisplay"
import AudioProgressBar from "@/components/floatingBar/audioProgressBar"

const AudioSlot = () => {
	const { queueItem } = useAudioQueue()
	const playing = useAudioPlaying()
	const loading = useAudioLoading()
	const textForeground = useResolveClassNames("text-foreground")
	const { pictureUri, titleLabel, artistLabel } = useNowPlayingDisplay(queueItem ?? null)

	const onBodyPress = () => {
		router.push("/playlists")
	}

	const onTogglePlay = () => {
		if (playing) {
			audio.pause()
		} else {
			audio.resume()
		}
	}

	if (!queueItem) {
		return null
	}

	return (
		<PressableScale
			className="flex-1 flex-col overflow-hidden min-h-11"
			rippleColor="transparent"
			onPress={onBodyPress}
		>
			<View className="flex-row items-center px-3 py-2 gap-2 bg-transparent flex-1">
				<View className="flex-row items-center gap-2 bg-transparent flex-1">
					<AudioThumbnail
						pictureUri={pictureUri}
						size={32}
						recyclingKey={`toolbar-audio-picture-${queueItem.item.data.uuid}`}
					/>
					<View className="flex-col bg-transparent flex-1 justify-center">
						<Text
							className="text-xs"
							numberOfLines={1}
							ellipsizeMode="middle"
						>
							{titleLabel}
						</Text>
						<Text
							className="text-xs text-muted-foreground"
							numberOfLines={1}
							ellipsizeMode="middle"
						>
							{artistLabel}
						</Text>
					</View>
				</View>
				<PressableScale
					className="shrink-0 size-5 items-center justify-center"
					rippleColor="transparent"
					onPress={onTogglePlay}
				>
					{loading ? (
						<ActivityIndicator
							size="small"
							color={textForeground.color}
						/>
					) : (
						<Ionicons
							name={playing ? "pause" : "play"}
							size={18}
							color={textForeground.color}
						/>
					)}
				</PressableScale>
			</View>
			<AudioProgressBar />
		</PressableScale>
	)
}

export default AudioSlot
