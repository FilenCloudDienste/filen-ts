import { Fragment, useState } from "react"
import { useTranslation } from "react-i18next"
import View from "@/components/ui/view"
import { AnimatedView } from "@/components/ui/animated"
import Text from "@/components/ui/text"
import { PressableScale } from "@/components/ui/pressables"
import Ionicons from "@expo/vector-icons/Ionicons"
import { type TextStyle, useWindowDimensions, ActivityIndicator } from "react-native"
import useAudioMetadataQuery from "@/features/audio/queries/useAudioMetadata.query"
import { ImageBackground, Image } from "@/components/ui/image"
import { useResolveClassNames } from "uniwind"
import { Gesture, GestureDetector } from "react-native-gesture-handler"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { type SharedValue, useSharedValue, useAnimatedStyle, withSpring, useDerivedValue } from "react-native-reanimated"
import { runOnJS } from "react-native-worklets"
import { Paths } from "expo-file-system"
import { type Metadata } from "@/features/audio/audioCache"
import { type GalleryItemTagged, galleryItemKey } from "@/components/drivePreview/gallery"
import { driveItemDisplayName } from "@/lib/decryption"
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio"
import audio from "@/features/audio/audio"
import useEffectOnce from "@/hooks/useEffectOnce"

export const FONT_TABULAR_NUMS: TextStyle = {
	fontVariant: ["tabular-nums"]
}

export function formatAudioTime(seconds: number): string {
	if (!isFinite(seconds) || seconds < 0) {
		return "0:00"
	}

	const mins = Math.floor(seconds / 60)
	const secs = Math.floor(seconds % 60)

	return `${mins}:${secs < 10 ? "0" : ""}${secs}`
}

const Background = ({ children, blurhash }: { children: React.ReactNode; blurhash?: string }) => {
	if (!blurhash) {
		return <View className="bg-transparent flex-1 items-center justify-center px-4">{children}</View>
	}

	return (
		<ImageBackground
			className="bg-transparent flex-1 items-center justify-center px-4"
			contentFit="cover"
			cachePolicy="disk"
			recyclingKey={`preview-audio-bg-${blurhash}`}
			source={{
				blurhash
			}}
		>
			{children}
		</ImageBackground>
	)
}

const Picture = ({ blurhash, pictureUri, id }: { blurhash?: string; pictureUri?: string; id: string }) => {
	const dimensions = useWindowDimensions()
	const textForeground = useResolveClassNames("text-foreground")

	if (!blurhash) {
		return (
			<View
				className="bg-background-secondary items-center justify-center rounded-2xl overflow-hidden p-8 shadow-xl"
				style={{
					width: Math.floor(Math.min(dimensions.width, dimensions.height) * 0.5),
					height: Math.floor(Math.min(dimensions.width, dimensions.height) * 0.5)
				}}
			>
				{pictureUri ? (
					<Image
						className="size-full rounded-2xl"
						source={{
							uri: pictureUri
						}}
						contentFit="contain"
						cachePolicy="disk"
						recyclingKey={`preview-audio-picture-${id}`}
					/>
				) : (
					<Ionicons
						name="musical-notes"
						size={Math.floor(Math.min(dimensions.width, dimensions.height) * 0.2)}
						color={textForeground.color}
					/>
				)}
			</View>
		)
	}

	return (
		<ImageBackground
			className="bg-transparent items-center justify-center rounded-2xl overflow-hidden p-8 shadow-xl"
			source={{
				blurhash
			}}
			style={{
				width: Math.floor(Math.min(dimensions.width, dimensions.height) * 0.5),
				height: Math.floor(Math.min(dimensions.width, dimensions.height) * 0.5)
			}}
			contentFit="cover"
			cachePolicy="disk"
			recyclingKey={`preview-audio-bg-${blurhash}`}
		>
			<Image
				className="size-full rounded-2xl"
				source={{
					uri: pictureUri
				}}
				contentFit="contain"
				cachePolicy="disk"
				recyclingKey={`preview-audio-picture-${blurhash}`}
			/>
		</ImageBackground>
	)
}

const THUMB_SIZE = 14
const TRACK_HEIGHT = 4
const HIT_SLOP_VERTICAL = 16
const THUMB_SPRING = {
	duration: 200,
	dampingRatio: 0.8
}

type SliderSharedValues = {
	isSeeking: SharedValue<boolean>
	seekProgress: SharedValue<number>
	thumbScale: SharedValue<number>
}

function buildSliderPanGesture(sv: SliderSharedValues, trackWidth: number, seekToPosition: (fraction: number) => void) {
	return Gesture.Pan()
		.hitSlop({
			top: HIT_SLOP_VERTICAL,
			bottom: HIT_SLOP_VERTICAL
		})
		.onStart(e => {
			"worklet"

			sv.isSeeking.value = true
			sv.thumbScale.value = withSpring(1.4, THUMB_SPRING)

			if (trackWidth > 0) {
				sv.seekProgress.value = Math.max(0, Math.min(1, e.x / trackWidth))
			}
		})
		.onUpdate(e => {
			"worklet"

			if (trackWidth > 0) {
				sv.seekProgress.value = Math.max(0, Math.min(1, e.x / trackWidth))
			}
		})
		.onEnd(() => {
			"worklet"

			sv.isSeeking.value = false
			sv.thumbScale.value = withSpring(1, THUMB_SPRING)

			runOnJS(seekToPosition)(sv.seekProgress.value)
		})
}

function buildSliderTapGesture(sv: SliderSharedValues, trackWidth: number, seekToPosition: (fraction: number) => void) {
	return Gesture.Tap().onEnd(e => {
		"worklet"

		if (trackWidth > 0) {
			sv.seekProgress.value = Math.max(0, Math.min(1, e.x / trackWidth))

			runOnJS(seekToPosition)(sv.seekProgress.value)
		}
	})
}

export const AudioSlider = ({
	currentTime,
	duration,
	onSeek
}: {
	currentTime: number
	duration: number
	onSeek: (seconds: number) => void
}) => {
	const [trackWidth, setTrackWidth] = useState<number>(0)
	const isSeeking = useSharedValue<boolean>(false)
	const seekProgress = useSharedValue<number>(0)
	const thumbScale = useSharedValue<number>(1)

	const normalizedProgress = duration > 0 ? Math.min(currentTime / duration, 1) : 0

	const progress = useDerivedValue(() => {
		if (isSeeking.value) {
			return seekProgress.value
		}

		return normalizedProgress
	})

	const seekToPosition = (fraction: number) => {
		if (duration > 0) {
			onSeek(fraction * duration)
		}
	}

	const sv = {
		isSeeking,
		seekProgress,
		thumbScale
	}

	const gesture = Gesture.Exclusive(
		buildSliderPanGesture(sv, trackWidth, seekToPosition),
		buildSliderTapGesture(sv, trackWidth, seekToPosition)
	)

	const fillStyle = useAnimatedStyle(() => {
		"worklet"

		return {
			width: `${progress.value * 100}%`
		}
	})

	const thumbStyle = useAnimatedStyle(() => {
		"worklet"

		return {
			left: `${progress.value * 100}%`,
			marginLeft: -(THUMB_SIZE / 2),
			transform: [
				{
					scale: thumbScale.value
				}
			]
		}
	})

	return (
		<GestureDetector gesture={gesture}>
			<View
				className="w-full justify-center bg-transparent"
				style={{
					height: THUMB_SIZE * 2
				}}
				onLayout={e => {
					setTrackWidth(e.nativeEvent.layout.width)
				}}
			>
				<View
					className="w-full bg-white/20 rounded-full"
					style={{
						height: TRACK_HEIGHT
					}}
				>
					<AnimatedView
						className="bg-white rounded-full"
						style={[
							{
								height: TRACK_HEIGHT
							},
							fillStyle
						]}
					/>
				</View>
				<AnimatedView
					className="absolute bg-white rounded-full"
					style={[
						{
							width: THUMB_SIZE,
							height: THUMB_SIZE,
							top: "50%",
							marginTop: -(THUMB_SIZE / 2)
						},
						thumbStyle
					]}
				/>
			</View>
		</GestureDetector>
	)
}

const PreviewAudioInner = ({ item, metadata, fileUrl }: { item: GalleryItemTagged; metadata: Metadata; fileUrl: string }) => {
	const { t } = useTranslation()
	const dimensions = useWindowDimensions()
	const insets = useSafeAreaInsets()
	const player = useAudioPlayer(fileUrl, {
		updateInterval: 1000,
		crossOrigin: "anonymous"
	})
	const status = useAudioPlayerStatus(player)

	const isLoadingOrBuffering = status.isBuffering || !status.isLoaded
	const isLandscape = dimensions.width > dimensions.height

	useEffectOnce(() => {
		audio.setAudioMode()
		audio.pause()
	})

	const cover = (
		<Picture
			blurhash={metadata?.pictureBlurhash ?? undefined}
			pictureUri={metadata?.pictureUri ?? undefined}
			id={galleryItemKey(item)}
		/>
	)

	const titleBlock = (
		<View className={`flex-col bg-transparent w-full px-4 items-center gap-1 ${isLandscape ? "" : "mt-6"}`}>
			{metadata?.title && metadata?.artist ? (
				<Fragment>
					<Text
						className="font-bold text-white"
						numberOfLines={1}
						ellipsizeMode="middle"
					>
						{metadata.artist}
					</Text>
					<Text
						className="text-white"
						numberOfLines={1}
						ellipsizeMode="middle"
					>
						{metadata.title}
					</Text>
				</Fragment>
			) : (
				<Fragment>
					<Text
						className="font-bold text-white"
						numberOfLines={1}
						ellipsizeMode="middle"
					>
						{t("unknown_artist")}
					</Text>
					<Text
						className="text-white"
						numberOfLines={1}
						ellipsizeMode="middle"
					>
						{Paths.parse(item.type === "drive" ? driveItemDisplayName(item.data) : item.data.name).name}
					</Text>
				</Fragment>
			)}
		</View>
	)

	const playButton = (
		<PressableScale
			className={`bg-white/20 size-16 rounded-full items-center justify-center ${isLandscape ? "mt-6 mb-4" : "mt-10 mb-6"}`}
			onPress={() => {
				if (isLoadingOrBuffering) {
					return
				}

				if (status.playing) {
					player.pause()
				} else if (status.didJustFinish) {
					player.seekTo(0)
					player.play()
				} else {
					player.play()
				}
			}}
		>
			{isLoadingOrBuffering ? (
				<ActivityIndicator
					color="white"
					size="small"
				/>
			) : (
				<Ionicons
					name={status.playing ? "pause" : "play"}
					size={32}
					color="white"
				/>
			)}
		</PressableScale>
	)

	const slider = (
		<View className="bg-transparent px-4 w-full">
			<AudioSlider
				currentTime={status.currentTime}
				duration={status.duration}
				onSeek={seconds => {
					player.seekTo(seconds)
				}}
			/>
		</View>
	)

	const timeRow = (
		<View className="w-full flex-row justify-between bg-transparent px-4">
			<Text
				className="text-white/70 text-xs"
				style={FONT_TABULAR_NUMS}
			>
				{formatAudioTime(status.currentTime)}
			</Text>
			<Text
				className="text-white/70 text-xs"
				style={FONT_TABULAR_NUMS}
			>
				{formatAudioTime(status.duration)}
			</Text>
		</View>
	)

	if (isLandscape) {
		return (
			<Background blurhash={metadata?.pictureBlurhash ?? undefined}>
				<View
					className="flex-row items-center justify-center bg-transparent w-full gap-8"
					style={{
						paddingLeft: insets.left,
						paddingRight: insets.right
					}}
				>
					{cover}
					<View className="flex-1 flex-col items-center justify-center bg-transparent max-w-md">
						{titleBlock}
						{playButton}
						{slider}
						{timeRow}
					</View>
				</View>
			</Background>
		)
	}

	return (
		<Background blurhash={metadata?.pictureBlurhash ?? undefined}>
			{cover}
			{titleBlock}
			{playButton}
			{slider}
			{timeRow}
		</Background>
	)
}

const PreviewAudio = ({ item, fileUrl }: { item: GalleryItemTagged; fileUrl: string }) => {
	const audioMetadataQuery = useAudioMetadataQuery(
		item.type === "drive"
			? {
					type: "drive",
					data: {
						uuid: item.data.data.uuid
					}
				}
			: {
					type: "external",
					data: {
						url: item.data.url,
						name: item.data.name
					}
				}
	)

	if (audioMetadataQuery.status !== "success") {
		return (
			<View className="bg-transparent flex-1 items-center justify-center">
				<ActivityIndicator
					size="small"
					color="white"
				/>
			</View>
		)
	}

	return (
		<PreviewAudioInner
			item={item}
			metadata={audioMetadataQuery.data}
			fileUrl={fileUrl}
		/>
	)
}

export default PreviewAudio
