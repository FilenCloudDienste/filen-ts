import { useState, memo } from "react"
import View from "@/components/ui/view"
import { AnimatedView } from "@/components/ui/animated"
import { router } from "expo-router"
import { type DriveItemFileExtracted } from "@/types"
import { getPreviewType } from "@/lib/utils"
import { useWindowDimensions, type ViewabilityConfig } from "react-native"
import { GestureDetector, Gesture } from "react-native-gesture-handler"
import { useSharedValue, useAnimatedStyle, type SharedValue, withSpring } from "react-native-reanimated"
import { FlashList, type ViewToken } from "@shopify/flash-list"
import useDriveItemsQuery from "@/queries/useDriveItems.query"
import { itemSorter } from "@/lib/sort"
import type { DrivePath } from "@/hooks/useDrivePath"
import GalleryHeader from "@/components/drivePreview/header"
import GalleryItem from "@/components/drivePreview/galleryItem"
import useDrivePreviewStore from "@/stores/useDrivePreview.store"
import { runOnJS } from "react-native-worklets"
import type { AnyDirWithContext } from "@filen/sdk-rs"
import { useShallow } from "zustand/shallow"

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

			if (sv.dismissTranslateY.value > screenHeight * DISMISS_POSITION_RATIO || e.velocityY > DISMISS_VELOCITY_THRESHOLD) {
				runOnJS(goBack)()
			} else {
				sv.dismissTranslateY.value = withSpring(0, {
					...SPRING_SNAPPY,
					velocity: e.velocityY
				})
			}
		})
}

function setHeaderOpacityValue(headerOpacity: SharedValue<number>, visible: boolean) {
	headerOpacity.value = withSpring(visible ? 1 : 0, SPRING_HEADER)
}

const Gallery = memo(({ item, drivePath, parent }: { item: DriveItemFileExtracted; drivePath: DrivePath; parent?: AnyDirWithContext }) => {
	const dimensions = useWindowDimensions()
	const [scrollEnabled, setScrollEnabled] = useState<boolean>(true)
	const headerOpacity = useSharedValue<number>(1)
	const zoomScale = useSharedValue<number>(1)
	const dismissTranslateY = useSharedValue<number>(0)
	const savedDismissTranslateY = useSharedValue<number>(0)
	const startTouchX = useSharedValue<number>(0)
	const startTouchY = useSharedValue<number>(0)
	const isDismissing = useSharedValue<number>(0)

	const fadeRange = dimensions.height * 0.5

	const driveItemsQuery = useDriveItemsQuery(
		{
			path: drivePath
		},
		{
			enabled: false
		}
	)

	const goBack = () => {
		isDismissing.value = 1
		headerOpacity.value = 0

		if (!router.canGoBack()) {
			return
		}

		router.back()
	}

	const onZoomChange = (zoom: number) => {
		zoomScale.value = zoom

		setScrollEnabled(zoom <= 1)
	}

	const { isImage, isVideo, isAudio } = useDrivePreviewStore(
		useShallow(state => {
			if (!state.currentItem) {
				return {
					isImage: false,
					isVideo: false,
					isAudio: false
				}
			}

			const previewType = getPreviewType(state.currentItem.data.decryptedMeta?.name ?? "")

			return {
				isImage: previewType === "image",
				isVideo: previewType === "video",
				isAudio: previewType === "audio"
			}
		})
	)

	const onSingleTap = () => {
		if (!isImage) {
			return
		}

		headerOpacity.value = withSpring(headerOpacity.value > 0.5 ? 0 : 1, SPRING_HEADER)
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

	const onViewableItemsChanged = (info: {
		viewableItems: ViewToken<DriveItemFileExtracted>[]
		changed: ViewToken<DriveItemFileExtracted>[]
	}) => {
		const first = info.viewableItems[0]

		if (first && first.item) {
			useDrivePreviewStore.getState().setCurrentItem(first.item)
			useDrivePreviewStore.getState().setCurrentIndex(first.index ?? -1)

			setHeaderOpacityValue(headerOpacity, true)
		}
	}

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
	).enabled(isImage || isVideo || isAudio)

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

	const itemsSorted = (() => {
		const basePreviewType = getPreviewType(item.data.decryptedMeta?.name ?? "")

		if (basePreviewType === "docx" || basePreviewType === "text" || basePreviewType === "pdf" || basePreviewType === "code") {
			return [item]
		}

		const items = driveItemsQuery.status === "success" && driveItemsQuery.data.length > 0 ? driveItemsQuery.data : [item]

		if (drivePath.type === "photos") {
			return itemSorter.sortItems(
				items.filter(item => {
					if (!item.data.decryptedMeta || (item.type !== "file" && item.type !== "sharedFile")) {
						return false
					}

					const previewType = getPreviewType(item.data.decryptedMeta.name)

					return previewType === "image" || previewType === "video"
				}),
				"creationDesc"
			) as DriveItemFileExtracted[]
		}

		return itemSorter.sortItems(items, "nameAsc").filter(i => {
			if (!item.data.decryptedMeta || (item.type !== "file" && item.type !== "sharedFile")) {
				return false
			}

			const type = getPreviewType(i.data.decryptedMeta?.name ?? "")

			return type === "image" || type === "video" || type === "audio"
		}) as DriveItemFileExtracted[]
	})()

	const initialScrollIndex = itemsSorted.findIndex(i => i.data.uuid === item.data.uuid)

	return (
		<View className="flex-1 bg-transparent">
			<AnimatedView
				className="absolute inset-0 bg-black"
				style={backgroundAnimatedStyle}
			/>
			<GalleryHeader
				animatedStyle={headerAnimatedStyle}
				goBack={goBack}
				drivePath={drivePath}
				parent={parent}
			/>
			<GestureDetector gesture={dismissGesture}>
				<AnimatedView className="flex-1 bg-transparent">
					<FlashList<DriveItemFileExtracted>
						data={itemsSorted}
						keyExtractor={item => item.data.uuid}
						renderItem={info => {
							return (
								<GalleryItem
									info={info}
									galleryZoomScale={zoomScale}
									dismissTranslateY={dismissTranslateY}
									isDismissing={isDismissing}
									fadeRange={fadeRange}
									goBack={goBack}
									onZoomChange={onZoomChange}
									onSingleTap={onSingleTap}
									parent={parent}
								/>
							)
						}}
						drawDistance={dimensions.width}
						horizontal={true}
						pagingEnabled={itemsSorted.length > 1}
						scrollEnabled={scrollEnabled && itemsSorted.length > 1 && (isImage || isVideo || isAudio)}
						bounces={itemsSorted.length > 1}
						maxItemsInRecyclePool={0}
						showsHorizontalScrollIndicator={false}
						initialScrollIndex={initialScrollIndex >= 0 && initialScrollIndex < itemsSorted.length ? initialScrollIndex : 0}
						onViewableItemsChanged={onViewableItemsChanged}
						viewabilityConfig={VIEWABILITY_CONFIG}
					/>
				</AnimatedView>
			</GestureDetector>
		</View>
	)
})

export default Gallery
