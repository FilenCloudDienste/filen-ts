import { useState, useEffect, memo } from "react"
import View from "@/components/ui/view"
import { AnimatedView } from "@/components/ui/animated"
import { router } from "expo-router"
import { type DriveItemFileExtracted } from "@/types"
import { getPreviewType } from "@/lib/utils"
import { useWindowDimensions } from "react-native"
import { GestureDetector, Gesture } from "react-native-gesture-handler"
import { useSharedValue, useAnimatedStyle, type SharedValue, withSpring } from "react-native-reanimated"
import type { DrivePath } from "@/hooks/useDrivePath"
import GalleryHeader from "@/components/drivePreview/header"
import GalleryItem from "@/components/drivePreview/galleryItem"
import useDrivePreviewStore from "@/stores/useDrivePreview.store"
import { runOnJS } from "react-native-worklets"
import { useShallow } from "zustand/shallow"
import * as ScreenOrientation from "expo-screen-orientation"
import Text from "@/components/ui/text"
import type { External } from "@/routes/drivePreview"
import { FlashList } from "@shopify/flash-list"

const DISMISS_POSITION_RATIO = 0.25
const DISMISS_VELOCITY_THRESHOLD = 1000

const SPRING_SNAPPY = {
	duration: 350,
	dampingRatio: 0.86
}

const SPRING_HEADER = {
	duration: 250,
	dampingRatio: 1
}

const ORIENTATION_TO_LOCK: Record<number, ScreenOrientation.OrientationLock | undefined> = {
	[ScreenOrientation.Orientation.PORTRAIT_UP]: ScreenOrientation.OrientationLock.PORTRAIT_UP,
	[ScreenOrientation.Orientation.PORTRAIT_DOWN]: ScreenOrientation.OrientationLock.PORTRAIT_DOWN,
	[ScreenOrientation.Orientation.LANDSCAPE_LEFT]: ScreenOrientation.OrientationLock.LANDSCAPE_LEFT,
	[ScreenOrientation.Orientation.LANDSCAPE_RIGHT]: ScreenOrientation.OrientationLock.LANDSCAPE_RIGHT
}

async function lockToCurrentOrientation(): Promise<void> {
	const orientation = await ScreenOrientation.getOrientationAsync()
	const lock = ORIENTATION_TO_LOCK[orientation]

	if (lock !== undefined) {
		await ScreenOrientation.lockAsync(lock)
	}
}

type DismissSharedValues = {
	zoomScale: SharedValue<number>
	dismissTranslateY: SharedValue<number>
	savedDismissTranslateY: SharedValue<number>
	startTouchX: SharedValue<number>
	startTouchY: SharedValue<number>
}

export type InitialItem =
	| {
			type: "drive"
			data: {
				item: DriveItemFileExtracted
				drivePath: DrivePath
			}
	  }
	| {
			type: "external"
			data: External
	  }

export type GalleryItemTagged =
	| {
			type: "drive"
			data: DriveItemFileExtracted
	  }
	| {
			type: "external"
			data: External
	  }

function buildDismissGesture(
	sv: DismissSharedValues,
	screenHeight: number,
	goBack: () => void,
	onDismissStart: () => void,
	onDismissCancel: () => void
) {
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

			runOnJS(onDismissStart)()
		})
		.onUpdate(e => {
			"worklet"

			const ty = sv.savedDismissTranslateY.value + e.translationY

			sv.dismissTranslateY.value = ty > 0 ? ty : ty * 0.3
		})
		.onEnd(e => {
			"worklet"

			if (sv.dismissTranslateY.value > screenHeight * DISMISS_POSITION_RATIO || e.velocityY > DISMISS_VELOCITY_THRESHOLD) {
				runOnJS(goBack)()
			} else {
				sv.dismissTranslateY.value = withSpring(0, {
					...SPRING_SNAPPY,
					velocity: e.velocityY
				})

				runOnJS(onDismissCancel)()
			}
		})
}

function setHeaderOpacityValue(headerOpacity: SharedValue<number>, visible: boolean) {
	headerOpacity.value = withSpring(visible ? 1 : 0, SPRING_HEADER)
}

function back({ isDismissing, headerOpacity }: { isDismissing: SharedValue<number>; headerOpacity: SharedValue<number> }) {
	isDismissing.value = 1
	headerOpacity.value = 0

	if (!router.canGoBack()) {
		return
	}

	router.back()
}

function changeZoom(zoomScale: SharedValue<number>, newZoom: number) {
	zoomScale.value = newZoom
}

const Gallery = memo(() => {
	const dimensions = useWindowDimensions()
	const [scrollEnabled, setScrollEnabled] = useState<boolean>(true)
	const [isDismissGestureActive, setIsDismissGestureActive] = useState<boolean>(false)
	const headerOpacity = useSharedValue<number>(1)
	const zoomScale = useSharedValue<number>(1)
	const dismissTranslateY = useSharedValue<number>(0)
	const savedDismissTranslateY = useSharedValue<number>(0)
	const startTouchX = useSharedValue<number>(0)
	const startTouchY = useSharedValue<number>(0)
	const isDismissing = useSharedValue<number>(0)
	const items = useDrivePreviewStore(useShallow(state => state.items))
	const initialScrollIndex = useDrivePreviewStore(useShallow(state => state.initialScrollIndex))

	const fadeRange = dimensions.height * 0.5

	const onDismissGestureStart = () => {
		lockToCurrentOrientation().catch(console.error)

		setIsDismissGestureActive(true)
	}

	const onDismissGestureEnd = () => {
		ScreenOrientation.unlockAsync().catch(console.error)

		setIsDismissGestureActive(false)
	}

	const goBack = () => {
		back({
			isDismissing,
			headerOpacity
		})
	}

	const onZoomChange = (zoom: number) => {
		changeZoom(zoomScale, zoom)
		setScrollEnabled(zoom <= 1)

		if (zoom > 1) {
			lockToCurrentOrientation().catch(console.error)
		} else {
			ScreenOrientation.unlockAsync().catch(console.error)
		}
	}

	const { isImage, isVideo, isAudio, isExternal } = useDrivePreviewStore(
		useShallow(state => {
			if (!state.currentItem) {
				return {
					isImage: false,
					isVideo: false,
					isAudio: false,
					isExternal: false
				}
			}

			const previewType = getPreviewType(
				state.currentItem.type === "drive" ? (state.currentItem.data.data.decryptedMeta?.name ?? "") : state.currentItem.data.name
			)

			return {
				isImage: previewType === "image",
				isVideo: previewType === "video",
				isAudio: previewType === "audio",
				isExternal: state.currentItem.type === "external"
			}
		})
	)

	const onSingleTap = () => {
		if (!isImage) {
			return
		}

		setHeaderOpacityValue(headerOpacity, headerOpacity.value < 0.5)
	}

	const headerAnimatedStyle = useAnimatedStyle(() => {
		"worklet"

		if (zoomScale.value > 1 || isDismissing.value === 1) {
			return {
				opacity: 0
			}
		}

		const panProgress = Math.abs(dismissTranslateY.value) / fadeRange
		const pinchProgress = zoomScale.value < 1 ? 1 - zoomScale.value : 0
		const dismissProgress = Math.max(0, Math.min(1, Math.max(panProgress, pinchProgress)))

		if (!isImage) {
			return {
				opacity: 1 - dismissProgress
			}
		}

		return {
			opacity: headerOpacity.value * (1 - dismissProgress)
		}
	})

	const dismissAnimatedStyle = useAnimatedStyle(() => {
		"worklet"

		const progress = Math.max(0, Math.min(1, Math.abs(dismissTranslateY.value) / fadeRange))

		return {
			transform: [
				{
					translateY: dismissTranslateY.value
				},
				{
					scale: 1 - progress * 0.15
				}
			]
		}
	})

	const backgroundAnimatedStyle = useAnimatedStyle(() => {
		"worklet"

		if (isDismissing.value === 1) {
			return {
				opacity: 0
			}
		}

		const panProgress = Math.abs(dismissTranslateY.value) / fadeRange
		const pinchProgress = zoomScale.value < 1 ? 1 - zoomScale.value : 0
		const gestureProgress = Math.max(0, Math.min(1, Math.max(panProgress, pinchProgress)))

		return {
			opacity: 1 - gestureProgress
		}
	})

	const dismissGesture = buildDismissGesture(
		{
			zoomScale,
			dismissTranslateY,
			savedDismissTranslateY,
			startTouchX,
			startTouchY
		},
		dimensions.height,
		goBack,
		onDismissGestureStart,
		onDismissGestureEnd
	).enabled(isImage || isVideo || isAudio || items.length === 0 || (isExternal && (isImage || isVideo || isAudio)))

	useEffect(() => {
		return () => {
			useDrivePreviewStore.getState().reset()

			ScreenOrientation.unlockAsync().catch(console.error)
		}
	}, [])

	return (
		<View className="flex-1 bg-transparent">
			<AnimatedView
				className="absolute inset-0 bg-black"
				style={backgroundAnimatedStyle}
			/>
			<GalleryHeader
				animatedStyle={headerAnimatedStyle}
				goBack={goBack}
			/>
			<GestureDetector gesture={dismissGesture}>
				<AnimatedView
					className="flex-1 bg-transparent"
					style={dismissAnimatedStyle}
				>
					<FlashList<GalleryItemTagged>
						data={items}
						keyExtractor={item => (item.type === "drive" ? item.data.data.uuid : item.data.url)}
						renderItem={info => {
							return (
								<GalleryItem
									info={info}
									galleryZoomScale={zoomScale}
									goBack={goBack}
									onZoomChange={onZoomChange}
									onSingleTap={onSingleTap}
								/>
							)
						}}
						drawDistance={dimensions.width}
						maxItemsInRecyclePool={0}
						horizontal={true}
						pagingEnabled={items.length > 1 && !isDismissGestureActive}
						scrollEnabled={scrollEnabled && !isDismissGestureActive && items.length > 1 && (isImage || isVideo || isAudio)}
						bounces={items.length > 1}
						showsHorizontalScrollIndicator={false}
						initialScrollIndex={initialScrollIndex >= 0 && initialScrollIndex < items.length ? initialScrollIndex : 0}
						onViewableItemsChanged={info => {
							const first = info.viewableItems[0]

							if (first && first.item) {
								useDrivePreviewStore.getState().setCurrentItem(first.item)
								useDrivePreviewStore.getState().setCurrentIndex(first.index ?? -1)

								setHeaderOpacityValue(headerOpacity, true)
							}
						}}
						viewabilityConfig={{
							itemVisiblePercentThreshold: 50
						}}
						ListEmptyComponent={() => {
							return (
								<View
									className="flex-1 items-center justify-center bg-transparent"
									style={{
										width: dimensions.width,
										height: dimensions.height
									}}
								>
									<Text className="text-base text-foreground">tbd_no_preview</Text>
								</View>
							)
						}}
					/>
				</AnimatedView>
			</GestureDetector>
		</View>
	)
})

export default Gallery
