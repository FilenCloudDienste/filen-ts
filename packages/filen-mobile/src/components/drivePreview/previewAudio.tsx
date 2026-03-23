import { useState, Fragment } from "react"
import { memo, useCallback, useMemo } from "@/lib/memo"
import View from "@/components/ui/view"
import { AnimatedView } from "@/components/ui/animated"
import Text from "@/components/ui/text"
import { PressableScale } from "@/components/ui/pressables"
import Ionicons from "@expo/vector-icons/Ionicons"
import audio, { useAudio } from "@/lib/audio"
import alerts from "@/lib/alerts"
import { type TextStyle, type LayoutChangeEvent, useWindowDimensions, ActivityIndicator } from "react-native"
import useAudioMetadataQuery from "@/queries/useAudioMetadata.query"
import { Image, ImageBackground } from "@/components/ui/image"
import { useResolveClassNames } from "uniwind"
import { Gesture, GestureDetector } from "react-native-gesture-handler"
import { type SharedValue, useSharedValue, useAnimatedStyle, withSpring, useDerivedValue } from "react-native-reanimated"
import { runOnJS } from "react-native-worklets"
import { Paths } from "expo-file-system"
import type { DriveItemFileExtracted } from "@/types"
import { type Metadata } from "@/lib/audioCache"
import useEffectOnce from "@/hooks/useEffectOnce"

const FONT_TABULAR_NUMS: TextStyle = {
	fontVariant: ["tabular-nums"]
}

function formatAudioTime(seconds: number): string {
	if (!isFinite(seconds) || seconds < 0) {
		return "0:00"
	}

	const mins = Math.floor(seconds / 60)
	const secs = Math.floor(seconds % 60)

	return `${mins}:${secs < 10 ? "0" : ""}${secs}`
}

const Background = memo(({ children, blurhash }: { children: React.ReactNode; blurhash?: string }) => {
	if (!blurhash) {
		return <View className="bg-transparent flex-1 items-center justify-center px-4">{children}</View>
	}

	return (
		<ImageBackground
			className="bg-transparent flex-1 items-center justify-center px-4"
			contentFit="cover"
			cachePolicy="disk"
			source={{
				blurhash
			}}
		>
			{children}
		</ImageBackground>
	)
})

const Picture = memo(({ blurhash, pictureBase64 }: { blurhash?: string; pictureBase64?: string }) => {
	const dimensions = useWindowDimensions()
	const textForeground = useResolveClassNames("text-foreground")

	if (!blurhash) {
		return (
			<View
				className="bg-background-secondary items-center justify-center rounded-2xl overflow-hidden p-8 shadow-xl"
				style={{
					width: Math.floor(dimensions.width * 0.5),
					height: Math.floor(dimensions.width * 0.5)
				}}
			>
				{pictureBase64 ? (
					<Image
						className="size-full rounded-2xl"
						source={{
							uri: pictureBase64
						}}
						contentFit="contain"
						cachePolicy="disk"
					/>
				) : (
					<Ionicons
						name="musical-notes"
						size={Math.floor(dimensions.width * 0.2)}
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
				width: Math.floor(dimensions.width * 0.5),
				height: Math.floor(dimensions.width * 0.5)
			}}
			contentFit="cover"
			cachePolicy="disk"
		>
			<Image
				className="size-full rounded-2xl"
				source={{
					uri: pictureBase64
				}}
				contentFit="contain"
			/>
		</ImageBackground>
	)
})

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

const AudioSlider = memo(
	({ currentTime, duration, onSeek }: { currentTime: number; duration: number; onSeek: (seconds: number) => void }) => {
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

		const onTrackLayout = useCallback((e: LayoutChangeEvent) => {
			setTrackWidth(e.nativeEvent.layout.width)
		}, [])

		const seekToPosition = useCallback(
			(fraction: number) => {
				if (duration > 0) {
					onSeek(fraction * duration)
				}
			},
			[duration, onSeek]
		)

		const sv = useMemo<SliderSharedValues>(
			() => ({
				isSeeking,
				seekProgress,
				thumbScale
			}),
			[isSeeking, seekProgress, thumbScale]
		)

		const gesture = useMemo(() => {
			return Gesture.Exclusive(
				buildSliderPanGesture(sv, trackWidth, seekToPosition),
				buildSliderTapGesture(sv, trackWidth, seekToPosition)
			)
		}, [trackWidth, seekToPosition, sv])

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
					onLayout={onTrackLayout}
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
)

const PreviewAudioInner = memo(({ item, metadata }: { item: DriveItemFileExtracted; metadata: Metadata }) => {
	const { status, pausePreview, resumePreview, seekPreview, loading } = useAudio()

	const isLoadingOrBuffering = useMemo(() => {
		return loading || (status["preview"]?.isBuffering ?? false) || !(status["preview"]?.isLoaded ?? false)
	}, [status, loading])

	const onPlayPause = useCallback(() => {
		if (isLoadingOrBuffering) {
			return
		}

		if (status["preview"] && status["preview"].playing) {
			pausePreview()
		} else if (status["preview"] && status["preview"].didJustFinish) {
			seekPreview(0)
			resumePreview()
		} else {
			resumePreview()
		}
	}, [status, pausePreview, resumePreview, seekPreview, isLoadingOrBuffering])

	const onSeek = useCallback(
		(seconds: number) => {
			seekPreview(seconds)
		},
		[seekPreview]
	)

	useEffectOnce(() => {
		audio.enterPreviewMode({ item }).catch(err => {
			console.error(err)
			alerts.error(err)
		})

		return () => {
			// TODO: Fix when exiting drivePreview and playlist player is active
			// audio.exitPreviewMode()
		}
	})

	return (
		<Background blurhash={metadata?.pictureBlurhash ?? undefined}>
			<Picture
				blurhash={metadata?.pictureBlurhash ?? undefined}
				pictureBase64={metadata?.pictureBase64 ?? undefined}
			/>
			<View className="flex-col mt-6 bg-transparent w-full px-4 items-center gap-1">
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
							tbd_unkwn_artist
						</Text>
						<Text
							className="text-white"
							numberOfLines={1}
							ellipsizeMode="middle"
						>
							{Paths.parse(item.data.decryptedMeta?.name ?? item.data.uuid).name}
						</Text>
					</Fragment>
				)}
			</View>
			<PressableScale
				className="bg-white/20 size-16 rounded-full mt-10 mb-6 items-center justify-center"
				onPress={onPlayPause}
			>
				{isLoadingOrBuffering ? (
					<ActivityIndicator
						color="white"
						size="small"
					/>
				) : (
					<Ionicons
						name={status["preview"]?.playing ? "pause" : "play"}
						size={32}
						color="white"
					/>
				)}
			</PressableScale>
			<View className="bg-transparent px-4 w-full">
				<AudioSlider
					currentTime={status["preview"]?.currentTime ?? 0}
					duration={status["preview"]?.duration ?? 0}
					onSeek={onSeek}
				/>
			</View>
			<View className="w-full flex-row justify-between bg-transparent px-4">
				<Text
					className="text-white/70 text-xs"
					style={FONT_TABULAR_NUMS}
				>
					{formatAudioTime(status["preview"]?.currentTime ?? 0)}
				</Text>
				<Text
					className="text-white/70 text-xs"
					style={FONT_TABULAR_NUMS}
				>
					{formatAudioTime(status["preview"]?.duration ?? metadata?.duration ?? 0)}
				</Text>
			</View>
		</Background>
	)
})

const PreviewAudio = memo(({ item }: { item: DriveItemFileExtracted }) => {
	const audioMetadataQuery = useAudioMetadataQuery({
		uuid: item.data.uuid
	})

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
		/>
	)
})

export default PreviewAudio
