import { memo } from "react"
import { router } from "expo-router"
import { ActivityIndicator } from "react-native"
import audio, { useAudio } from "@/lib/audio"
import View from "@/components/ui/view"
import Text from "@/components/ui/text"
import { PressableScale } from "@/components/ui/pressables"
import FontAwesome6 from "@expo/vector-icons/FontAwesome6"
import { useResolveClassNames } from "uniwind"

const AudioSlot = memo(() => {
	const { status, loading, queueItem } = useAudio()
	const textForeground = useResolveClassNames("text-foreground")

	if (!queueItem) {
		return null
	}

	const playing = status?.playing ?? false
	const title = queueItem.item.data.decryptedMeta?.name ?? queueItem.item.data.uuid

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

	return (
		<PressableScale
			className="flex-1 flex-row items-center px-3 py-2 gap-3"
			rippleColor="transparent"
			onPress={onBodyPress}
		>
			<View className="flex-1 bg-transparent">
				<Text
					className="text-sm"
					numberOfLines={1}
					ellipsizeMode="tail"
				>
					{title}
				</Text>
			</View>
			<PressableScale
				className="shrink-0 size-8 items-center justify-center"
				rippleColor="transparent"
				onPress={onTogglePlay}
			>
				{loading ? (
					<ActivityIndicator
						size="small"
						color={textForeground.color}
					/>
				) : (
					<FontAwesome6
						name={playing ? "pause" : "play"}
						size={16}
						color={textForeground.color}
					/>
				)}
			</PressableScale>
		</PressableScale>
	)
})

AudioSlot.displayName = "AudioSlot"

export default AudioSlot
