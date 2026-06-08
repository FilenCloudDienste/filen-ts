import { useTranslation } from "react-i18next"
import { router } from "expo-router"
import { ActivityIndicator } from "react-native"
import audio, { useAudio } from "@/features/audio/audio"
import View from "@/components/ui/view"
import Text from "@/components/ui/text"
import { PressableScale } from "@/components/ui/pressables"
import { useResolveClassNames } from "uniwind"
import useAudioMetadataQuery from "@/features/audio/queries/useAudioMetadata.query"
import Image from "@/components/ui/image"
import Ionicons from "@expo/vector-icons/Ionicons"
import { resolveAudioTrackLabels } from "@/features/audio/utils"

const AudioSlot = () => {
	const { t } = useTranslation()
	const { status, loading, queueItem } = useAudio()
	const textForeground = useResolveClassNames("text-foreground")

	const audioMetadataQuery = useAudioMetadataQuery(
		{
			type: "drive",
			data: {
				uuid: queueItem?.item.data.uuid ?? ""
			}
		},
		{
			enabled: !!queueItem
		}
	)

	const playing = status?.playing ?? false

	const { titleLabel, artistLabel } = resolveAudioTrackLabels(
		queueItem ?? null,
		audioMetadataQuery.status === "success",
		audioMetadataQuery.data?.title,
		audioMetadataQuery.data?.artist,
		{
			notPlaying: t("not_playing"),
			unknownTitle: t("unknown_title"),
			unknownArtist: t("unknown_artist")
		}
	)

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
			className="flex-1 flex-row items-center px-3 py-2 gap-2 min-h-11"
			rippleColor="transparent"
			onPress={onBodyPress}
		>
			<View className="flex-row items-center gap-2 bg-transparent flex-1">
				{audioMetadataQuery.status === "success" && audioMetadataQuery.data?.pictureUri ? (
					<Image
						className="size-8 rounded-lg bg-background-tertiary"
						source={{
							uri: audioMetadataQuery.data.pictureUri
						}}
						contentFit="contain"
						cachePolicy="disk"
						recyclingKey={`toolbar-audio-picture-${queueItem.item.data.uuid}`}
					/>
				) : (
					<View className="bg-background-tertiary size-8 rounded-lg flex-row items-center justify-center">
						<Ionicons
							name="musical-note"
							size={16}
							color={textForeground.color}
						/>
					</View>
				)}
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
		</PressableScale>
	)
}

export default AudioSlot
