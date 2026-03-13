import { useState, useEffect } from "react"
import { memo, useMemo, useCallback } from "@/lib/memo"
import ZoomableView from "@/components/ui/zoomableView"
import View from "@/components/ui/view"
import { AnimatedView } from "@/components/ui/animated"
import { router, useLocalSearchParams } from "expo-router"
import { type DriveItemFileExtracted, type DriveItem } from "@/types"
import { Buffer } from "react-native-quick-crypto"
import { unpack } from "@/lib/msgpack"
import { type DrivePath } from "@/hooks/useDrivePath"
import useEffectOnce from "@/hooks/useEffectOnce"
import Image from "@/components/ui/image"
import Text from "@/components/ui/text"
import { getPreviewType } from "@/lib/utils"
import useHttpStore from "@/stores/useHttp.store"
import { useShallow } from "zustand/shallow"
import { AnyFile } from "@filen/sdk-rs"
import { useWindowDimensions, type ViewStyle, type ViewabilityConfig } from "react-native"
import { Gesture, GestureDetector } from "react-native-gesture-handler"
import { type SharedValue, useSharedValue, useAnimatedStyle, withTiming } from "react-native-reanimated"
import { runOnJS } from "react-native-worklets"
import { FlashList, type ListRenderItemInfo, type ViewToken } from "@shopify/flash-list"
import useDriveItemsQuery from "@/queries/useDriveItems.query"
import { itemSorter } from "@/lib/sort"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { PressableScale } from "@/components/ui/pressables"
import Ionicons from "@expo/vector-icons/Ionicons"
import { VideoView, useVideoPlayer } from "expo-video"
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio"

const DISMISS_POSITION_RATIO = 0.1
const DISMISS_VELOCITY_THRESHOLD = 1000

const zoomableViewStyle: ViewStyle = {
	flex: 1,
	alignItems: "center",
	justifyContent: "center"
}

const VIEWABILITY_CONFIG: ViewabilityConfig = {
	itemVisiblePercentThreshold: 50
}

type DismissSharedValues = {
	zoomScale: SharedValue<number>
	dismissTranslateY: SharedValue<number>
	savedDismissTranslateY: SharedValue<number>
	startTouchX: SharedValue<number>
	startTouchY: SharedValue<number>
}

function getFileUrlForItem(item: DriveItem, getFileUrl: (file: AnyFile) => string): string | null {
	try {
		switch (item.type) {
			case "file": {
				return getFileUrl(new AnyFile.File(item.data))
			}

			case "sharedFile": {
				return getFileUrl(new AnyFile.Shared(item.data))
			}
		}
	} catch (e) {
		console.error(e)

		return null
	}

	return null
}

function handleZoomChange(zoomScale: SharedValue<number>, zoom: number, setScrollEnabled: (enabled: boolean) => void) {
	zoomScale.value = zoom

	setScrollEnabled(zoom <= 1)
}

function handleSingleTap(headerOpacity: SharedValue<number>, isImage: boolean) {
	if (!isImage) {
		return
	}

	headerOpacity.value = withTiming(headerOpacity.value > 0.5 ? 0 : 1, {
		duration: 200
	})
}

function setHeaderOpacity(headerOpacity: SharedValue<number>, visible: boolean) {
	headerOpacity.value = withTiming(visible ? 1 : 0, {
		duration: 200
	})
}

function buildDismissGesture(sv: DismissSharedValues, screenHeight: number, goBack: () => void) {
	return Gesture.Pan()
		.manualActivation(true)
		.onTouchesDown((e, _stateManager) => {
			"worklet"

			const touch = e.allTouches[0]

			if (e.allTouches.length === 1 && touch) {
				sv.startTouchX.value = touch.x
				sv.startTouchY.value = touch.y
			}
		})
		.onTouchesMove((e, stateManager) => {
			"worklet"

			if (sv.zoomScale.value > 1 || e.allTouches.length !== 1) {
				stateManager.fail()

				return
			}

			const touch = e.allTouches[0]

			if (!touch) {
				stateManager.fail()

				return
			}

			const dx = touch.x - sv.startTouchX.value
			const dy = touch.y - sv.startTouchY.value

			if (dy > 10 && Math.abs(dy) > Math.abs(dx) * 1.5) {
				stateManager.activate()
			} else if (Math.abs(dx) > 10 || dy < -10) {
				stateManager.fail()
			}
		})
		.onStart(() => {
			"worklet"

			sv.savedDismissTranslateY.value = sv.dismissTranslateY.value
		})
		.onUpdate(e => {
			"worklet"

			const ty = sv.savedDismissTranslateY.value + e.translationY

			sv.dismissTranslateY.value = ty > 0 ? ty : ty * 0.3
		})
		.onEnd(e => {
			"worklet"

			const threshold = screenHeight * DISMISS_POSITION_RATIO

			if (sv.dismissTranslateY.value > threshold || e.velocityY > DISMISS_VELOCITY_THRESHOLD) {
				const remaining = screenHeight - sv.dismissTranslateY.value
				const speed = Math.max(Math.abs(e.velocityY), 800)
				const duration = Math.min(Math.max((remaining / speed) * 1000, 100), 350)

				sv.dismissTranslateY.value = withTiming(
					screenHeight,
					{
						duration
					},
					finished => {
						"worklet"

						if (finished) {
							runOnJS(goBack)()
						}
					}
				)
			} else {
				sv.dismissTranslateY.value = withTiming(0, {
					duration: 200
				})
			}
		})
}

const Return = memo(() => {
	useEffectOnce(() => {
		router.dismissAll()
	})

	return null
})

const GalleryHeader = memo(
	({
		title,
		animatedStyle,
		goBack
	}: {
		title: string
		animatedStyle: {
			opacity: number
		}
		goBack: () => void
	}) => {
		const insets = useSafeAreaInsets()

		return (
			<AnimatedView
				className="absolute top-0 left-0 right-0 z-10"
				style={[
					{
						paddingTop: insets.top
					},
					animatedStyle
				]}
			>
				<View className="flex-row items-center px-2 h-11 gap-2 bg-transparent">
					<PressableScale
						className="size-9 items-center justify-center"
						onPress={goBack}
						hitSlop={10}
					>
						<Ionicons
							name="chevron-back"
							size={24}
							color="white"
						/>
					</PressableScale>
					<Text
						className="flex-1 text-white font-semibold text-base"
						numberOfLines={1}
					>
						{title}
					</Text>
				</View>
			</AnimatedView>
		)
	}
)

const PreviewImage = memo(
	({
		fileUrl,
		zoomScale,
		onPinchDismiss,
		onZoomChange,
		onSingleTap
	}: {
		fileUrl: string
		zoomScale: SharedValue<number>
		onPinchDismiss: () => void
		onZoomChange?: (zoom: number) => void
		onSingleTap?: () => void
	}) => {
		const dimensions = useWindowDimensions()

		const imageStyle = useMemo(() => {
			return {
				width: dimensions.width,
				height: dimensions.height
			}
		}, [dimensions.width, dimensions.height])

		return (
			<ZoomableView
				style={[zoomableViewStyle, imageStyle]}
				scaleValue={zoomScale}
				onPinchDismiss={onPinchDismiss}
				onZoomChange={onZoomChange}
				onSingleTap={onSingleTap}
			>
				<Image
					className="flex-1 bg-transparent"
					source={{
						uri: fileUrl
					}}
					contentFit="contain"
					cachePolicy="disk"
					style={imageStyle}
				/>
			</ZoomableView>
		)
	}
)

const PreviewVideo = memo(({ fileUrl }: { fileUrl: string }) => {
	const dimensions = useWindowDimensions()

	const player = useVideoPlayer(fileUrl, p => {
		p.loop = false

		p.play()
	})

	const videoViewStyle = useMemo<ViewStyle>(() => {
		return {
			width: dimensions.width,
			height: dimensions.height
		}
	}, [dimensions.width, dimensions.height])

	return (
		<VideoView
			style={videoViewStyle}
			player={player}
			contentFit="contain"
			nativeControls={true}
			allowsPictureInPicture={false}
		/>
	)
})

function formatAudioTime(seconds: number): string {
	if (!isFinite(seconds) || seconds < 0) {
		return "0:00"
	}

	const mins = Math.floor(seconds / 60)
	const secs = Math.floor(seconds % 60)

	return `${mins}:${secs < 10 ? "0" : ""}${secs}`
}

const PreviewAudio = memo(({ fileUrl }: { fileUrl: string }) => {
	const player = useAudioPlayer(fileUrl)
	const status = useAudioPlayerStatus(player)

	const onPlayPause = useCallback(() => {
		if (status.playing) {
			player.pause()
		} else {
			player.play()
		}
	}, [player, status.playing])

	const progress = status.duration > 0 ? status.currentTime / status.duration : 0

	const progressWidth = useMemo(() => {
		return {
			width: `${Math.min(progress * 100, 100)}%` as const
		}
	}, [progress])

	return (
		<View className="flex-1 items-center justify-center px-4 bg-transparent">
			<PressableScale
				className="size-16 rounded-full bg-white/15 items-center justify-center mb-10"
				onPress={onPlayPause}
			>
				<Ionicons
					name={status.playing ? "pause" : "play"}
					size={36}
					color="white"
				/>
			</PressableScale>
			<View className="w-full h-1 bg-white/20 rounded-sm mb-2">
				<View
					className="h-1 bg-white rounded-sm"
					style={progressWidth}
				/>
			</View>
			<View className="w-full flex-row justify-between bg-transparent">
				<Text
					className="text-white/70 text-xs"
					style={{
						fontVariant: ["tabular-nums"]
					}}
				>
					{formatAudioTime(status.currentTime)}
				</Text>
				<Text
					className="text-white/70 text-xs"
					style={{
						fontVariant: ["tabular-nums"]
					}}
				>
					{formatAudioTime(status.duration)}
				</Text>
			</View>
		</View>
	)
})

const GalleryItem = memo(
	({
		info,
		goBack,
		onZoomChange,
		onSingleTap
	}: {
		info: ListRenderItemInfo<DriveItem>
		goBack: () => void
		onZoomChange?: (zoom: number) => void
		onSingleTap?: () => void
	}) => {
		const dimensions = useWindowDimensions()
		const getFileUrl = useHttpStore(useShallow(state => state.getFileUrl))
		const zoomScale = useSharedValue<number>(1)

		const previewType = useMemo(() => {
			return getPreviewType(info.item.data.decryptedMeta?.name ?? "")
		}, [info.item.data.decryptedMeta?.name])

		const fileUrl = useMemo(() => {
			if (!getFileUrl) {
				return null
			}

			return getFileUrlForItem(info.item, getFileUrl)
		}, [getFileUrl, info.item])

		const itemStyle = useMemo(() => {
			return {
				width: dimensions.width,
				height: dimensions.height
			}
		}, [dimensions.width, dimensions.height])

		if (!fileUrl || !previewType || previewType === "unknown") {
			return (
				<View
					className="bg-transparent"
					style={itemStyle}
				/>
			)
		}

		switch (previewType) {
			case "image": {
				return (
					<View
						className="bg-transparent"
						style={itemStyle}
					>
						<PreviewImage
							fileUrl={fileUrl}
							zoomScale={zoomScale}
							onPinchDismiss={goBack}
							onZoomChange={onZoomChange}
							onSingleTap={onSingleTap}
						/>
					</View>
				)
			}

			case "video": {
				return (
					<View
						className="bg-transparent"
						style={itemStyle}
					>
						<PreviewVideo fileUrl={fileUrl} />
					</View>
				)
			}

			case "audio": {
				return (
					<View
						className="bg-transparent"
						style={itemStyle}
					>
						<PreviewAudio fileUrl={fileUrl} />
					</View>
				)
			}

			default: {
				return (
					<View
						className="bg-transparent"
						style={itemStyle}
					/>
				)
			}
		}
	}
)

const Gallery = memo(({ item, drivePath }: { item: DriveItemFileExtracted; drivePath: DrivePath }) => {
	const dimensions = useWindowDimensions()
	const [scrollEnabled, setScrollEnabled] = useState<boolean>(true)
	const [currentItem, setCurrentItem] = useState<DriveItemFileExtracted>(item)
	const headerOpacity = useSharedValue<number>(1)
	const zoomScale = useSharedValue<number>(1)
	const dismissTranslateY = useSharedValue<number>(0)
	const savedDismissTranslateY = useSharedValue<number>(0)
	const startTouchX = useSharedValue<number>(0)
	const startTouchY = useSharedValue<number>(0)

	const dismissThreshold = dimensions.height * DISMISS_POSITION_RATIO

	const driveItemsQuery = useDriveItemsQuery(
		{
			path: drivePath
		},
		{
			enabled: false
		}
	)

	const goBack = useCallback(() => {
		router.dismissAll()
	}, [])

	const onZoomChange = useCallback(
		(zoom: number) => {
			handleZoomChange(zoomScale, zoom, setScrollEnabled)
		},
		[zoomScale]
	)

	const currentItemName = currentItem.data.decryptedMeta?.name ?? ""
	const currentPreviewType = getPreviewType(currentItemName)
	const isImage = currentPreviewType === "image"
	const isVideo = currentPreviewType === "video"

	const onSingleTap = useCallback(() => {
		handleSingleTap(headerOpacity, isImage)
	}, [headerOpacity, isImage])

	useEffect(() => {
		setHeaderOpacity(headerOpacity, !isVideo)
	}, [isVideo, headerOpacity])

	const headerAnimatedStyle = useAnimatedStyle(() => {
		"worklet"

		const panProgress = Math.abs(dismissTranslateY.value) / dismissThreshold
		const pinchProgress = zoomScale.value < 1 ? 1 - zoomScale.value : 0
		const dismissProgress = Math.max(0, Math.min(1, Math.max(panProgress, pinchProgress)))

		return {
			opacity: headerOpacity.value * (1 - dismissProgress)
		}
	})

	const onViewableItemsChanged = useCallback(
		(info: { viewableItems: ViewToken<DriveItemFileExtracted>[]; changed: ViewToken<DriveItemFileExtracted>[] }) => {
			const first = info.viewableItems[0]

			if (first && first.item) {
				setCurrentItem(first.item)
			}
		},
		[]
	)

	const dismissGesture = buildDismissGesture(
		{
			zoomScale,
			dismissTranslateY,
			savedDismissTranslateY,
			startTouchX,
			startTouchY
		},
		dimensions.height,
		goBack
	)

	const backgroundAnimatedStyle = useAnimatedStyle(() => {
		"worklet"

		const panProgress = Math.abs(dismissTranslateY.value) / dismissThreshold
		const pinchProgress = zoomScale.value < 1 ? 1 - zoomScale.value : 0
		const progress = Math.max(0, Math.min(1, Math.max(panProgress, pinchProgress)))

		return {
			opacity: 1 - progress
		}
	})

	const dismissContentStyle = useAnimatedStyle(() => {
		"worklet"

		const progress = Math.max(0, Math.min(1, Math.abs(dismissTranslateY.value) / dismissThreshold))

		return {
			backgroundColor: "transparent",
			transform: [
				{
					translateY: dismissTranslateY.value
				},
				{
					scale: 1 - progress * 0.3
				}
			]
		}
	})

	const itemsSorted = useMemo(() => {
		if (driveItemsQuery.status !== "success") {
			return []
		}

		return itemSorter.sortItems(driveItemsQuery.data, "nameAsc").filter(i => {
			const type = getPreviewType(i.data.decryptedMeta?.name ?? "")

			return type !== "unknown" && (i.type === "file" || i.type === "sharedFile")
		}) as DriveItemFileExtracted[]
	}, [driveItemsQuery.data, driveItemsQuery.status])

	const renderItem = useCallback(
		(info: ListRenderItemInfo<DriveItemFileExtracted>) => {
			return (
				<GalleryItem
					info={info}
					goBack={goBack}
					onZoomChange={onZoomChange}
					onSingleTap={onSingleTap}
				/>
			)
		},
		[goBack, onZoomChange, onSingleTap]
	)

	const keyExtractor = useCallback((driveItem: DriveItemFileExtracted) => {
		return driveItem.data.uuid
	}, [])

	const initialScrollIndex = useMemo(() => {
		return itemsSorted.findIndex(i => i.data.uuid === item.data.uuid)
	}, [itemsSorted, item])

	if (driveItemsQuery.status !== "success" || driveItemsQuery.data.length === 0) {
		return <Return />
	}

	return (
		<View className="flex-1 bg-transparent">
			<AnimatedView
				className="absolute inset-0 bg-black"
				style={backgroundAnimatedStyle}
			/>
			<GalleryHeader
				title={currentItemName}
				animatedStyle={headerAnimatedStyle}
				goBack={goBack}
			/>
			<GestureDetector gesture={dismissGesture}>
				<AnimatedView
					className="flex-1 bg-transparent"
					style={dismissContentStyle}
				>
					<FlashList<DriveItemFileExtracted>
						data={itemsSorted}
						keyExtractor={keyExtractor}
						renderItem={renderItem}
						horizontal={true}
						pagingEnabled={true}
						scrollEnabled={scrollEnabled}
						showsHorizontalScrollIndicator={false}
						initialScrollIndex={initialScrollIndex >= 0 ? initialScrollIndex : 0}
						onViewableItemsChanged={onViewableItemsChanged}
						viewabilityConfig={VIEWABILITY_CONFIG}
					/>
				</AnimatedView>
			</GestureDetector>
		</View>
	)
})

const DrivePreview = memo(() => {
	const searchParams = useLocalSearchParams<{
		drivePath?: string
		item?: string
	}>()

	const { drivePath, item } = useMemo((): {
		drivePath: DrivePath | null
		item: DriveItemFileExtracted | null
	} => {
		if (!searchParams.item || !searchParams.drivePath) {
			return {
				drivePath: null,
				item: null
			}
		}

		let item: DriveItem | null = null
		let drivePath: DrivePath | null = null

		try {
			item = unpack(Buffer.from(searchParams.item, "base64")) as DriveItem
			drivePath = unpack(Buffer.from(searchParams.drivePath, "base64")) as DrivePath
		} catch (e) {
			console.error(e)

			return {
				item: null,
				drivePath: null
			}
		}

		if (item?.type !== "file" && item?.type !== "sharedFile") {
			return {
				item: null,
				drivePath: null
			}
		}

		return {
			item,
			drivePath
		}
	}, [searchParams])

	const previewType = useMemo(() => {
		return getPreviewType(item?.data.decryptedMeta?.name ?? "")
	}, [item?.data.decryptedMeta?.name])

	if (!drivePath || !item || previewType === "unknown") {
		return <Return />
	}

	return (
		<Gallery
			item={item}
			drivePath={drivePath}
		/>
	)
})

export default DrivePreview
