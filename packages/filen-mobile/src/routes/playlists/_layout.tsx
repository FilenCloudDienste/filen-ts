import { Stack } from "expo-router"
import { memo, Fragment } from "react"
import View, { CrossGlassContainerView } from "@/components/ui/view"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { Platform, ActivityIndicator } from "react-native"
import Text from "@/components/ui/text"
import { useResolveClassNames } from "uniwind"
import audio, { useAudio } from "@/lib/audio"
import Image from "@/components/ui/image"
import { PressableScale } from "@/components/ui/pressables"
import Ionicons from "@expo/vector-icons/Ionicons"
import { cn } from "@filen/utils"
import { AudioSlider, FONT_TABULAR_NUMS, formatAudioTime } from "@/components/drivePreview/previewAudio"
import alerts from "@/lib/alerts"
import useAudioMetadataQuery from "@/queries/useAudioMetadata.query"

const Toolbar = memo(() => {
	const insets = useSafeAreaInsets()
	const textForeground = useResolveClassNames("text-foreground")
	const textBlue500 = useResolveClassNames("text-blue-500")
	const { queueItem: currentQueueItem, loading, status, loopMode, shuffleEnabled } = useAudio()

	const queueItem = loading ? null : currentQueueItem
	const buttonsEnabled = !!queueItem && !loading

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

	return (
		<View
			className="absolute left-0 right-0 bg-transparent px-4"
			style={{
				bottom: insets.bottom
			}}
		>
			<CrossGlassContainerView
				disableBlur={Platform.OS === "android"}
				className="flex-col overflow-hidden px-4 py-4 gap-4 rounded-3xl"
				disableInteraction={true}
			>
				<View className="flex-row items-center justify-between bg-transparent gap-6 flex-1">
					<View className="flex-row items-center gap-3 bg-transparent flex-1">
						{queueItem && audioMetadataQuery.status === "success" && audioMetadataQuery.data?.pictureUri ? (
							<Image
								className="size-10 rounded-lg bg-background-tertiary"
								source={{
									uri: audioMetadataQuery.data.pictureUri
								}}
								contentFit="contain"
								cachePolicy="disk"
								recyclingKey={`toolbar-audio-picture-${queueItem.item.data.uuid}`}
							/>
						) : (
							<View className="bg-background-tertiary size-10 rounded-lg flex-row items-center justify-center">
								<Ionicons
									name="musical-note"
									size={16}
									color={textForeground.color}
								/>
							</View>
						)}
						<View className="flex-col bg-transparent flex-1 justify-center">
							<Text
								numberOfLines={1}
								ellipsizeMode="middle"
							>
								{queueItem && audioMetadataQuery.status === "success"
									? (audioMetadataQuery.data?.title ?? queueItem.item.data.decryptedMeta?.name ?? "tbd_unknown_title")
									: "tbd_not_playing"}
							</Text>
							<Text
								className="text-xs text-muted-foreground"
								numberOfLines={1}
								ellipsizeMode="middle"
							>
								{queueItem && audioMetadataQuery.status === "success"
									? (audioMetadataQuery.data?.artist ?? "tbd_unknown_artist")
									: "tbd_not_playing"}
							</Text>
						</View>
					</View>
					<View
						className={cn(
							"bg-transparent flex-row items-center justify-center",
							!buttonsEnabled && "opacity-50 pointer-events-none"
						)}
					>
						<PressableScale
							hitSlop={15}
							rippleColor="transparent"
							onPress={() => {
								audio.clearQueue().catch(err => {
									console.error(err)
									alerts.error(err)
								})
							}}
							enabled={buttonsEnabled}
						>
							<Ionicons
								name="close"
								size={20}
								color={textForeground.color}
							/>
						</PressableScale>
					</View>
				</View>
				<View
					className={cn(
						"bg-transparent flex-col items-center px-2 flex-1 w-full",
						!buttonsEnabled && "opacity-50 pointer-events-none"
					)}
				>
					<AudioSlider
						currentTime={!currentQueueItem ? 0 : (status?.currentTime ?? 0)}
						duration={!currentQueueItem ? 0 : (status?.duration ?? 0)}
						onSeek={seconds => {
							if (!buttonsEnabled) {
								return
							}

							audio.seek(seconds).catch(err => {
								console.error(err)
								alerts.error(err)
							})
						}}
					/>
					<View className="w-full flex-row justify-between bg-transparent">
						<Text
							className="text-muted-foreground text-xs"
							style={FONT_TABULAR_NUMS}
						>
							{formatAudioTime(!currentQueueItem ? 0 : (status?.currentTime ?? 0))}
						</Text>
						<Text
							className="text-muted-foreground text-xs"
							style={FONT_TABULAR_NUMS}
						>
							{formatAudioTime(!currentQueueItem ? 0 : (status?.duration ?? 0))}
						</Text>
					</View>
				</View>
				<View
					className={cn(
						"flex-row items-center justify-between bg-transparent gap-4 flex-1 px-2",
						!buttonsEnabled && "opacity-50 pointer-events-none"
					)}
				>
					<PressableScale
						hitSlop={15}
						enabled={buttonsEnabled}
						onPress={() => {
							if (!buttonsEnabled) {
								return
							}

							audio.setShuffleEnabled(!shuffleEnabled).catch(err => {
								console.error(err)
								alerts.error(err)
							})
						}}
					>
						<Ionicons
							name="shuffle-outline"
							size={24}
							color={shuffleEnabled ? textBlue500.color : textForeground.color}
						/>
					</PressableScale>
					<PressableScale
						hitSlop={15}
						enabled={buttonsEnabled}
						onPress={() => {
							if (!buttonsEnabled) {
								return
							}

							audio.previous().catch(err => {
								console.error(err)
								alerts.error(err)
							})
						}}
					>
						<Ionicons
							name="play-skip-back"
							size={24}
							color={textForeground.color}
						/>
					</PressableScale>
					<PressableScale
						hitSlop={15}
						className="bg-background-tertiary rounded-full size-12 flex-row items-center justify-center"
						enabled={buttonsEnabled}
						onPress={() => {
							if (!buttonsEnabled) {
								return
							}

							if (status?.playing) {
								audio.pause()
							} else {
								audio.resume()
							}
						}}
					>
						{loading ? (
							<ActivityIndicator
								size="small"
								color={textForeground.color}
							/>
						) : (
							<Ionicons
								name={status?.playing ? "pause" : "play"}
								size={24}
								color={textForeground.color}
							/>
						)}
					</PressableScale>
					<PressableScale
						hitSlop={15}
						enabled={buttonsEnabled}
						onPress={() => {
							if (!buttonsEnabled) {
								return
							}

							audio.next().catch(err => {
								console.error(err)
								alerts.error(err)
							})
						}}
					>
						<Ionicons
							name="play-skip-forward"
							size={24}
							color={textForeground.color}
						/>
					</PressableScale>
					<PressableScale
						hitSlop={15}
						enabled={buttonsEnabled}
						onPress={() => {
							if (!buttonsEnabled) {
								return
							}

							audio.setLoopMode(loopMode === "none" ? "queue" : loopMode === "queue" ? "track" : "none").catch(err => {
								console.error(err)
								alerts.error(err)
							})
						}}
					>
						{loopMode === "track" && (
							<View className="absolute -top-2 -right-2 bg-blue-500 rounded-full size-4 items-center justify-center">
								<Text className="text-white text-xs">1</Text>
							</View>
						)}
						<Ionicons
							name="repeat-outline"
							size={24}
							color={loopMode === "none" ? textForeground.color : textBlue500.color}
						/>
					</PressableScale>
				</View>
			</CrossGlassContainerView>
		</View>
	)
})

const Layout = memo(() => {
	return (
		<Fragment>
			<Stack />
			<Toolbar />
		</Fragment>
	)
})

export default Layout
