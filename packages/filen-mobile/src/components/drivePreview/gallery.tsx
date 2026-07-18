import { useState, useEffect, useRef } from "react"
import { useTranslation } from "react-i18next"
import usePipStore from "@/stores/usePip.store"
import View from "@/components/ui/view"
import { AnimatedView } from "@/components/ui/animated"
import { useNavigation } from "expo-router"
import { router } from "@/lib/router"
import { type DriveItemFileExtracted } from "@/types"
import { getPreviewType, isImagePreviewType } from "@/lib/previewType"
import { useWindowDimensions, Platform, type NativeSyntheticEvent, type NativeScrollEvent, type LayoutChangeEvent } from "react-native"
import { SystemBars } from "react-native-edge-to-edge"
import { GestureDetector, Gesture } from "react-native-gesture-handler"
import { useSharedValue, useAnimatedStyle, type SharedValue, withSpring, interpolate, Extrapolation } from "react-native-reanimated"
import { type DrivePath } from "@/hooks/useDrivePath"
import GalleryHeader from "@/components/drivePreview/header"
import GalleryItem from "@/components/drivePreview/galleryItem"
import useDrivePreviewStore from "@/stores/useDrivePreview.store"
import events from "@/lib/events"
import { driveItemDisplayName } from "@/lib/decryption"
import { runOnJS } from "react-native-worklets"
import { useShallow } from "zustand/shallow"
import * as ScreenOrientation from "expo-screen-orientation"
import ListEmpty from "@/components/ui/listEmpty"
import Button from "@/components/ui/button"
import { type External } from "@/routes/drivePreview"
import { FlashList, type FlashListRef } from "@shopify/flash-list"
import galleryVideoPlayers from "@/components/drivePreview/galleryVideoPlayers"
import logger from "@/lib/logger"

const DISMISS_POSITION_RATIO = 0.22
const DISMISS_VELOCITY_THRESHOLD = 800
const DISMISS_CANCEL_VELOCITY = -300
const DISMISS_EXIT_DISTANCE_RATIO = 1.1
const DISMISS_EXIT_X_PROJECTION = 0.1
const DISMISS_MIN_SCALE = 0.72
const PINCH_BG_FADE_END = 0.7

const SPRING_SNAPPY = {
	duration: 350,
	dampingRatio: 0.86
}

// Exit flight after a committed dismiss — critically damped so the content
// sails offscreen without bouncing back into view.
const SPRING_EXIT = {
	duration: 320,
	dampingRatio: 1
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
	dismissTranslateX: SharedValue<number>
	dismissTranslateY: SharedValue<number>
	savedDismissTranslateX: SharedValue<number>
	savedDismissTranslateY: SharedValue<number>
	startTouchX: SharedValue<number>
	startTouchY: SharedValue<number>
	isDismissing: SharedValue<number>
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

export function galleryItemKey(item: GalleryItemTagged): string {
	return item.type === "drive" ? item.data.data.uuid : item.data.url
}

/**
 * iOS-Photos-style dismissal: the content follows the finger on both axes,
 * and background/header/scale all DERIVE from dismissTranslateY so every frame
 * is continuous — there is no state flip that snaps opacity.
 *
 * On a committed dismiss we own the exit animation ourselves (velocity-matched
 * springs that carry the finger's momentum offscreen) and only then call
 * router.back() with the navigator's pop animation disabled: the screen is
 * already invisible at that point, so animating its removal would only keep
 * an untouchable transparent overlay over the app for the transition's
 * duration (500ms on iOS).
 */
function buildDismissGesture(
	sv: DismissSharedValues,
	screenHeight: number,
	goBack: () => void,
	onDismissStart: () => void,
	onDismissCancel: () => void
) {
	return Gesture.Pan()
		.manualActivation(true)
		.onTouchesDown((e, stateManager) => {
			"worklet"

			if (sv.isDismissing.value === 1) {
				stateManager.fail()

				return
			}

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

			sv.savedDismissTranslateX.value = sv.dismissTranslateX.value
			sv.savedDismissTranslateY.value = sv.dismissTranslateY.value

			runOnJS(onDismissStart)()
		})
		.onUpdate(e => {
			"worklet"

			const ty = sv.savedDismissTranslateY.value + e.translationY

			sv.dismissTranslateY.value = ty > 0 ? ty : ty * 0.3
			sv.dismissTranslateX.value = sv.savedDismissTranslateX.value + e.translationX
		})
		.onEnd(e => {
			"worklet"

			const passedDistance = sv.dismissTranslateY.value > screenHeight * DISMISS_POSITION_RATIO
			const flungDown = e.velocityY > DISMISS_VELOCITY_THRESHOLD
			const flungUp = e.velocityY < DISMISS_CANCEL_VELOCITY

			if (flungDown || (passedDistance && !flungUp)) {
				sv.isDismissing.value = 1

				sv.dismissTranslateX.value = withSpring(sv.dismissTranslateX.value + e.velocityX * DISMISS_EXIT_X_PROJECTION, {
					...SPRING_EXIT,
					velocity: e.velocityX
				})

				sv.dismissTranslateY.value = withSpring(
					screenHeight * DISMISS_EXIT_DISTANCE_RATIO,
					{
						...SPRING_EXIT,
						velocity: e.velocityY
					},
					finished => {
						"worklet"

						if (finished) {
							runOnJS(goBack)()
						}
					}
				)

				return
			}

			sv.dismissTranslateY.value = withSpring(0, {
				...SPRING_SNAPPY,
				velocity: e.velocityY
			})

			sv.dismissTranslateX.value = withSpring(0, {
				...SPRING_SNAPPY,
				velocity: e.velocityX
			})

			runOnJS(onDismissCancel)()
		})
}

function setHeaderOpacityValue(headerOpacity: SharedValue<number>, visible: boolean) {
	headerOpacity.value = withSpring(visible ? 1 : 0, SPRING_HEADER)
}

// didNavigateBack guards against the exit spring's completion callback and the
// header close button both popping the route.
function navigateBack({ didNavigateBack, isDismissing }: { didNavigateBack: SharedValue<number>; isDismissing: SharedValue<number> }) {
	if (didNavigateBack.value === 1) {
		return
	}

	didNavigateBack.value = 1
	isDismissing.value = 1

	if (!router.canGoBack()) {
		return
	}

	router.back()
}

const Gallery = () => {
	const { t } = useTranslation()
	const navigation = useNavigation()
	const dimensions = useWindowDimensions()
	const [scrollEnabled, setScrollEnabled] = useState<boolean>(true)
	const headerOpacity = useSharedValue<number>(1)
	const zoomScale = useSharedValue<number>(1)
	const dismissTranslateX = useSharedValue<number>(0)
	const dismissTranslateY = useSharedValue<number>(0)
	const savedDismissTranslateX = useSharedValue<number>(0)
	const savedDismissTranslateY = useSharedValue<number>(0)
	const startTouchX = useSharedValue<number>(0)
	const startTouchY = useSharedValue<number>(0)
	const isDismissing = useSharedValue<number>(0)
	const didNavigateBack = useSharedValue<number>(0)
	const items = useDrivePreviewStore(useShallow(state => state.items))
	const initialScrollIndex = useDrivePreviewStore(useShallow(state => state.initialScrollIndex))
	const zoomedInRef = useRef<boolean>(false)

	const fadeRange = dimensions.height * 0.5
	const width = dimensions.width

	// PiP freezes the remount key (spec: docs/pip-video-player.md §5.7, post-implementation review):
	// entering/exiting PiP RESIZES the window, so the dimension flip would remount the width-keyed
	// list mid-transition — tearing the presenting view out while expo-video's native code is
	// re-parenting its playerView (the "child already has a parent" crash class) and killing the
	// session. The remount exists for user-facing rotation; a PiP window flip must not trigger it.
	// During-render adjustment (the codebase's prev-state pattern) so the frozen value commits in
	// the same pass; it catches up to the live width on the first render after the session ends.
	const pipSessionActive = usePipStore(state => state.activeKey !== null)
	const [pipFrozenWidth, setPipFrozenWidth] = useState<number>(width)

	if (!pipSessionActive && pipFrozenWidth !== width) {
		setPipFrozenWidth(width)
	}

	// The page the carousel last SETTLED on. Updated only from momentum-end
	// offsets, so mid-rotation viewability misfires (FlashList recomputes
	// viewability with stale item layouts against the new viewport) can never
	// poison it — unlike store.currentIndex.
	const [anchorIndex, setAnchorIndex] = useState<number>(initialScrollIndex)
	// Mirror of anchorIndex readable from the (mount-time) event subscriptions
	// below without re-subscribing on every settle.
	const anchorIndexRef = useRef<number>(initialScrollIndex)

	const onMomentumScrollEnd = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
		// Android PiP resizes the ACTIVITY window while the list stays mounted (the remount key is
		// deliberately frozen during a session): clamp/settle scrolls against the tiny viewport
		// fire momentum-end with garbage geometry and would poison the anchor — the expand-back
		// re-anchor (onListContainerLayout, geometry-proof by design) then faithfully restores the
		// WRONG page. A PiP session pins the pager on Android. iOS in-app PiP keeps the pager
		// interactive by design (its window never resizes), so its settles stay legitimate.
		if (Platform.OS === "android" && usePipStore.getState().activeKey !== null) {
			return
		}

		const pageWidth = e.nativeEvent.layoutMeasurement.width

		if (pageWidth <= 0) {
			return
		}

		const storeItems = useDrivePreviewStore.getState().items
		const index = Math.max(0, Math.min(Math.round(e.nativeEvent.contentOffset.x / pageWidth), Math.max(0, storeItems.length - 1)))

		setAnchorIndex(index)
		anchorIndexRef.current = index

		// Cached video players keep playing through page transitions (and through
		// rotation remounts — that is their purpose); stop the ones the pager
		// settled away from.
		const settledItem = storeItems[index]

		galleryVideoPlayers.pauseAllExcept(settledItem ? galleryItemKey(settledItem) : null)
	}

	const listRef = useRef<FlashListRef<GalleryItemTagged> | null>(null)
	const anchoredWidthRef = useRef<number>(0)

	// Geometry-proof re-anchor: pages sit at exactly index * containerWidth
	// (full-width cells), so the target offset needs none of FlashList's item
	// layout data — which recomputes asynchronously after a resize and is the
	// reason index-based scrollToIndex around rotations lands between pages.
	// Runs on EVERY measured width change, so a mount that raced a rotation and
	// anchored against transient mid-rotation geometry corrects itself as soon
	// as the final layout lands.
	const onListContainerLayout = (e: LayoutChangeEvent) => {
		const measuredWidth = e.nativeEvent.layout.width
		const itemCount = useDrivePreviewStore.getState().items.length

		if (measuredWidth <= 0 || itemCount <= 1) {
			return
		}

		if (Math.abs(measuredWidth - anchoredWidthRef.current) < 0.5) {
			return
		}

		anchoredWidthRef.current = measuredWidth

		const index = Math.max(0, Math.min(anchorIndex, itemCount - 1))

		listRef.current?.scrollToOffset({
			offset: index * measuredWidth,
			animated: false
		})
	}

	const onDismissGestureStart = () => {
		lockToCurrentOrientation().catch(e => logger.warn("gallery", "lockToCurrentOrientation failed on dismiss start", { error: e }))
	}

	const onDismissGestureEnd = () => {
		ScreenOrientation.unlockAsync().catch(e => logger.warn("gallery", "unlockAsync failed on dismiss end", { error: e }))
	}

	const goBack = () => {
		navigateBack({
			didNavigateBack,
			isDismissing
		})
	}

	// Both gesture dismissals (the swipe-down exit flight and the pinch fade)
	// end with the content offscreen/invisible and the backdrop at zero
	// opacity, so the navigator's stock pop would animate an invisible screen
	// that keeps swallowing touches until it unmounts. Disable the pop
	// animation for these paths only — the override is stored per route
	// instance and cleared on unmount, so the next push still slides in from
	// the bottom. The header close button keeps the animated pop because its
	// content is still fully visible. The options live on the PARENT screen:
	// drivePreview is a nested stack, and the root stack's "drivePreview"
	// screen is what gets popped.
	const goBackFromGestureDismiss = () => {
		navigation.getParent()?.setOptions({
			animation: "none"
		})

		// The override has to reach the native screen in its own commit: when
		// the setOptions render is batched together with the pop's removal,
		// Fabric emits no prop update for a subtree deleted in that same
		// commit, so the native screen still pops with the old animation. One
		// frame is enough to flush the prop before dispatching the pop.
		requestAnimationFrame(() => {
			navigateBack({
				didNavigateBack,
				isDismissing
			})
		})
	}

	// scrollEnabled reflects ONLY the settled zoom state. An active pinch is
	// blocked synchronously on the UI thread by ZoomableView's stateManager
	// .activate(); toggling scrollEnabled from JS here (the old !pinchActiveRef
	// term) was an async round-trip the native scroll didn't wait for, so the
	// pager slid sideways under the pinch.
	const syncScrollEnabled = () => {
		setScrollEnabled(!zoomedInRef.current)
	}

	const onZoomChange = (zoom: number) => {
		zoomedInRef.current = zoom > 1

		syncScrollEnabled()

		if (zoom > 1) {
			lockToCurrentOrientation().catch(e => logger.warn("gallery", "lockToCurrentOrientation failed on zoom in", { error: e }))
		} else {
			ScreenOrientation.unlockAsync().catch(e => logger.warn("gallery", "unlockAsync failed on zoom out", { error: e }))
		}
	}

	// The pager is blocked DURING a pinch synchronously by ZoomableView's
	// stateManager.activate() (UI thread), not from here. This callback only
	// re-anchors on release: a staggered pinch (the second finger lands after the
	// first nudged the pager) can cancel an in-flight native scroll and leave the
	// pager resting between pages, so when the pinch releases back at rest we snap
	// onto the page it happened on. A clean pinch never moved the pager → target
	// equals the current offset → no visible jump.
	const onPinchActiveChange = (active: boolean) => {
		if (active || zoomScale.value > 1) {
			return
		}

		const itemCount = useDrivePreviewStore.getState().items.length

		if (itemCount > 1 && width > 0) {
			listRef.current?.scrollToOffset({
				offset: Math.max(0, Math.min(anchorIndex, itemCount - 1)) * width,
				animated: false
			})
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
				state.currentItem.type === "drive" ? driveItemDisplayName(state.currentItem.data) : state.currentItem.data.name
			)

			return {
				isImage: isImagePreviewType(previewType),
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

	// In-place immersive landscape (#53): rotating to landscape hides the gallery header and the
	// system bars (and previewVideo drops its paddings), so the media fills the physical screen
	// where it stands. Covers videos AND images — paging between the two must not flip the chrome
	// in and out — while document types (pdf/docx/text) and audio keep the header: their header X
	// is a primary exit (the swipe-down dismiss gesture is disabled for the document types).
	// Deliberately NOT expo-video's native fullscreen: on Android that launches a separate
	// activity, which backgrounds MainActivity (HTTP provider teardown mid-playback + biometric
	// arming — spec §3a) and pauses the JS runtime entirely. Gated off during a PiP session — the
	// Android PiP window's tiny landscape-ish dimensions must not flip the (frozen-width) gallery
	// into immersive state underneath the session.
	const immersive = dimensions.width > dimensions.height && (isVideo || isImage) && !pipSessionActive

	const headerAnimatedStyle = useAnimatedStyle(() => {
		"worklet"

		const zoomFade = interpolate(zoomScale.value, [1, 1.2], [1, 0], Extrapolation.CLAMP)
		const panProgress = Math.abs(dismissTranslateY.value) / fadeRange
		const pinchProgress = zoomScale.value < 1 ? (1 - zoomScale.value) / (1 - PINCH_BG_FADE_END) : 0
		const dismissFade = 1 - Math.min(1, Math.max(panProgress, pinchProgress) * 1.5)
		const base = immersive ? 0 : isImage ? headerOpacity.value : 1

		return {
			opacity: Math.max(0, base * zoomFade * dismissFade)
		}
	})

	const dismissAnimatedStyle = useAnimatedStyle(() => {
		"worklet"

		const progress = Math.min(1, Math.abs(dismissTranslateY.value) / fadeRange)

		return {
			transform: [
				{
					translateX: dismissTranslateX.value
				},
				{
					translateY: dismissTranslateY.value
				},
				{
					scale: interpolate(progress, [0, 1], [1, DISMISS_MIN_SCALE], Extrapolation.CLAMP)
				}
			]
		}
	})

	const backgroundAnimatedStyle = useAnimatedStyle(() => {
		"worklet"

		const panProgress = Math.abs(dismissTranslateY.value) / fadeRange
		const pinchProgress = zoomScale.value < 1 ? (1 - zoomScale.value) / (1 - PINCH_BG_FADE_END) : 0

		return {
			opacity: 1 - Math.min(1, Math.max(panProgress, pinchProgress))
		}
	})

	const dismissGesture = buildDismissGesture(
		{
			zoomScale,
			dismissTranslateX,
			dismissTranslateY,
			savedDismissTranslateX,
			savedDismissTranslateY,
			startTouchX,
			startTouchY,
			isDismissing
		},
		dimensions.height,
		goBackFromGestureDismiss,
		onDismissGestureStart,
		onDismissGestureEnd
	).enabled(isImage || isVideo || isAudio || items.length === 0 || (isExternal && (isImage || isVideo || isAudio)))

	useEffect(() => {
		return () => {
			useDrivePreviewStore.getState().reset()

			galleryVideoPlayers.releaseAll()

			ScreenOrientation.unlockAsync().catch(e => logger.warn("gallery", "unlockAsync failed on unmount", { error: e }))
		}
	}, [])

	// Keep the open preview in sync when the previewed file changes identity or
	// location elsewhere: a version restore rotates the uuid (so the page reseeds
	// with fresh content), and a move changes the parent (so the preview's own
	// save targets the new directory). Match by the pre-change uuid and swap in
	// the updated item.
	useEffect(() => {
		const updateSubscription = events.subscribe("driveItemUpdated", ({ previousUuid, item }) => {
			if (item.type !== "file" && item.type !== "sharedFile" && item.type !== "sharedRootFile") {
				return
			}

			const replacement: GalleryItemTagged = {
				type: "drive",
				data: item
			}

			useDrivePreviewStore
				.getState()
				.setCurrentItems(prev =>
					prev.map(existing => (existing.type === "drive" && existing.data.data.uuid === previousUuid ? replacement : existing))
				)

			useDrivePreviewStore
				.getState()
				.setCurrentItem(prev => (prev && prev.type === "drive" && prev.data.data.uuid === previousUuid ? replacement : prev))
		})

		// Removal (trash / delete / restore-out-of-trash): drop the item from the
		// gallery list and re-render correctly — close if it was the last one, else
		// keep a neighbour visible.
		const removeSubscription = events.subscribe("driveItemRemoved", ({ uuid }) => {
			const storeItems = useDrivePreviewStore.getState().items
			const removedIndex = storeItems.findIndex(existing => existing.type === "drive" && existing.data.data.uuid === uuid)

			if (removedIndex === -1) {
				return
			}

			const remaining = storeItems.filter((_, index) => index !== removedIndex)

			if (remaining.length === 0) {
				navigateBack({
					didNavigateBack,
					isDismissing
				})

				return
			}

			// Keep the same item visible: an earlier removal shifts everything left
			// by one; removing the current item lands on its neighbour (clamped to
			// the new last when it WAS the last).
			const anchor = anchorIndexRef.current
			const nextIndex = Math.max(0, Math.min(removedIndex < anchor ? anchor - 1 : anchor, remaining.length - 1))

			useDrivePreviewStore.getState().setCurrentItems(remaining)
			useDrivePreviewStore.getState().setCurrentIndex(nextIndex)
			useDrivePreviewStore.getState().setCurrentItem(remaining[nextIndex] ?? null)
			setAnchorIndex(nextIndex)
			anchorIndexRef.current = nextIndex

			const pageWidth = anchoredWidthRef.current

			// Re-anchor after the shorter list commits. Offset-based (index * width)
			// for the same reason onListContainerLayout is: scrollToIndex lands
			// between pages while FlashList's item layout is still async. If the
			// width is not measured yet, onListContainerLayout re-anchors to the
			// updated anchorIndex on the next layout pass instead.
			if (pageWidth > 0) {
				requestAnimationFrame(() => {
					listRef.current?.scrollToOffset({
						offset: nextIndex * pageWidth,
						animated: false
					})
				})
			}
		})

		return () => {
			updateSubscription.remove()
			removeSubscription.remove()
		}
	}, [didNavigateBack, isDismissing])

	return (
		<View className="flex-1 bg-transparent">
			{/* Always mounted with a DYNAMIC hidden value: SystemBars' entries-stack merge skips
			  * undefined props, so popping a hidden:true entry would leave the bars hidden (the
			  * native side is only touched by explicit values). Flipping the SAME entry to an
			  * explicit false re-shows the bars; the unmount-while-immersive path (dismissing the
			  * gallery in landscape) is covered by the StyleProvider's explicit hidden:false base
			  * entry, which the pop re-applies. */}
			<SystemBars hidden={{ statusBar: immersive, navigationBar: immersive }} />
			<AnimatedView
				className="absolute inset-0 bg-black"
				style={backgroundAnimatedStyle}
			/>
			<GalleryHeader
				animatedStyle={headerAnimatedStyle}
				goBack={goBack}
				// Faded out by the immersive style above — without this the invisible close/menu
				// buttons would still swallow taps at the top edge of the video.
				pointerEvents={immersive ? "none" : "auto"}
			/>
			<GestureDetector gesture={dismissGesture}>
				<AnimatedView
					className="flex-1 bg-transparent"
					style={dismissAnimatedStyle}
					onLayout={onListContainerLayout}
				>
					{/*
						Keyed by width: a rotation REMOUNTS the list so re-anchoring rides
						FlashList's hardened mount path (initialScrollIndex applies only once
						the new container has completed its first layout). Re-anchoring the
						live instance via scrollToIndex is unfixably racy in FlashList 2.x —
						container resizes recompute item layouts asynchronously (a render
						after onLayout), so any offset computed around a rotation reads stale
						item positions and the pager rests between pages; pagingEnabled never
						re-aligns programmatic offsets.
					*/}
					<FlashList<GalleryItemTagged>
						key={items.length > 1 ? `gallery-${pipFrozenWidth}` : "gallery"}
						ref={listRef}
						data={items}
						keyExtractor={item => galleryItemKey(item)}
						renderItem={info => {
							return (
								<GalleryItem
									info={info}
									galleryZoomScale={zoomScale}
									goBack={goBackFromGestureDismiss}
									onZoomChange={onZoomChange}
									onSingleTap={onSingleTap}
									onPinchActiveChange={onPinchActiveChange}
								/>
							)
						}}
						drawDistance={dimensions.width}
						maxItemsInRecyclePool={0}
						horizontal={true}
						pagingEnabled={items.length > 1}
						scrollEnabled={scrollEnabled && items.length > 1 && (isImage || isVideo || isAudio)}
						bounces={items.length > 1}
						showsHorizontalScrollIndicator={false}
						initialScrollIndex={anchorIndex >= 0 && anchorIndex < items.length ? anchorIndex : 0}
						onMomentumScrollEnd={onMomentumScrollEnd}
						onViewableItemsChanged={info => {
							// Same Android-PiP guard as onMomentumScrollEnd: viewability recomputed
							// against the tiny PiP-resized viewport must not churn currentItem /
							// currentIndex (wrong header + active-cell flips) while the session pins
							// the pager.
							if (Platform.OS === "android" && usePipStore.getState().activeKey !== null) {
								return
							}

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
						ListEmptyComponent={() => (
							<View
								className="flex-1 bg-transparent"
								style={{
									width: dimensions.width,
									height: dimensions.height
								}}
							>
								<ListEmpty
									icon="eye-off-outline"
									title={t("no_preview")}
									description={t("no_preview_description")}
									action={<Button onPress={() => router.back()}>{t("go_back")}</Button>}
								/>
							</View>
						)}
					/>
				</AnimatedView>
			</GestureDetector>
		</View>
	)
}

export default Gallery
