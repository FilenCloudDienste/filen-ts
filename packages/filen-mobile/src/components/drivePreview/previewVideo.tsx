import { useState, useEffect, useRef } from "react"
import { useWindowDimensions, Platform, AppState, type ViewStyle } from "react-native"
import { VideoView } from "expo-video"
import { useEvent } from "expo"
import useDrivePreviewStore from "@/stores/useDrivePreview.store"
import { useShallow } from "zustand/shallow"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import View from "@/components/ui/view"
import PreviewLoadingOverlay from "@/components/drivePreview/previewLoadingOverlay"
import galleryVideoPlayers from "@/components/drivePreview/galleryVideoPlayers"
import usePipStore from "@/stores/usePip.store"
import { useSecureStore } from "@/lib/secureStore"
import { PIP_ENABLED_SECURE_STORE_KEY, DEFAULT_PIP_ENABLED } from "@/constants"
import { ensureHttpProviderHealthy } from "@/components/http"
import logger from "@/lib/logger"

const PreviewVideo = ({ cacheKey, fileUrl }: { cacheKey: string; fileUrl: string }) => {
	const dimensions = useWindowDimensions()
	const headerHeight = useDrivePreviewStore(useShallow(state => state.headerHeight))
	const insets = useSafeAreaInsets()
	const [pipEnabled] = useSecureStore<boolean>(PIP_ENABLED_SECURE_STORE_KEY, DEFAULT_PIP_ENABLED)
	// Set when the Android PiP-permission-denied guard paused the player, so a late PiP-start can
	// undo exactly that pause (and only that pause — never a user-initiated one).
	const guardPausedRef = useRef<boolean>(false)

	// Session-owned player (get-or-create, render-idempotent): survives the
	// rotation remount of the carousel so playback continues uninterrupted.
	const player = galleryVideoPlayers.acquire({
		key: cacheKey,
		fileUrl
	})

	const { status } = useEvent(player, "statusChange", {
		status: player.status
	})

	const { isPlaying } = useEvent(player, "playingChange", {
		isPlaying: player.playing
	})

	// iOS: the PiP session is OWNED by this view's native playerViewController — unmounting the
	// presenting view (paging past it, or the gallery's rotation remount) deallocates it, killing
	// the PiP window, and the stop delegate dies with the view, so the JS stop event may never be
	// delivered. Clear the session signal ourselves or the lock/provider/cover suppressions stay
	// armed indefinitely (fail-open; post-implementation review finding 2). Nothing legitimate
	// unmounts the presenting view while a backgrounded session should survive (isActive and
	// dimensions are frozen in background), so this is fail-closed. Android is deliberately NOT
	// cleared here: its PiP session survives view remounts (the native stop broadcast reaches the
	// re-registered views), so an unmount-time clear would end a legitimately live session.
	useEffect(() => {
		if (Platform.OS !== "ios") {
			return
		}

		return () => {
			usePipStore.getState().setActiveKey(prev => (prev === cacheKey ? null : prev))
		}
	}, [cacheKey])

	// Backgrounded-PiP resume recovery (spec: docs/pip-video-player.md §5.5): iOS can suspend the
	// process while the video is PAUSED in PiP, killing the localhost provider's socket. When the
	// user taps play in the PiP window, probe the provider and restart it on the same port if dead;
	// a range-request failure can leave the player item terminally failed, so heal that too — the
	// URL is unchanged (pinned port), only the item state needs the reload.
	useEffect(() => {
		if (!isPlaying || AppState.currentState === "active" || usePipStore.getState().activeKey !== cacheKey) {
			return
		}

		ensureHttpProviderHealthy()
			.then(() => {
				if (player.status === "error") {
					return player.replaceAsync(fileUrl)
				}

				return
			})
			.catch(e => logger.warn("drivePreview", "PiP provider recovery failed", { cacheKey, error: e }))
	}, [isPlaying, cacheKey, fileUrl, player])

	// Android PiP-permission-denied guard (spec §5.7): with auto-enter flagged, expo-video elects
	// this player as the PiP candidate and never auto-pauses it — if the OS then refuses the PiP
	// window (special app access revoked), the video keeps playing audio-only in the background.
	// Android delivers the PiP mode-change (→ our PiP-start event) BEFORE the activity pause when
	// the window actually appears, so at "background" time the store is already set for a real PiP
	// entry. setImmediate is processed by the JS loop even while the activity is paused (unlike
	// timers, which freeze on Android) — double-deferred so any in-flight PiP-start event settles
	// first. iOS needs no guard: non-PiP players are paused natively on background.
	useEffect(() => {
		if (Platform.OS !== "android" || !pipEnabled) {
			return
		}

		const subscription = AppState.addEventListener("change", nextAppState => {
			if (nextAppState === "active") {
				// A guard pause is only undone by the PiP-start that explains it — anything else
				// (user returned to the app) makes the flag stale: a much later PiP start must not
				// force-play a video whose paused state the user now owns.
				guardPausedRef.current = false

				return
			}

			if (nextAppState !== "background" || !player.playing || usePipStore.getState().activeKey === cacheKey) {
				return
			}

			setImmediate(() => {
				setImmediate(() => {
					if (AppState.currentState === "active" || usePipStore.getState().activeKey === cacheKey || !player.playing) {
						return
					}

					guardPausedRef.current = true

					try {
						player.pause()
					} catch {
						// released natively already — nothing to pause
					}
				})
			})
		})

		return () => {
			subscription.remove()
		}
	}, [pipEnabled, cacheKey, player])

	// The loader is for the INITIAL load only. The player leaves "readyToPlay"
	// again when playback runs to the end (and on later rebuffers) — latching
	// keeps the overlay from reappearing over a finished video.
	const [hasLoadedOnce, setHasLoadedOnce] = useState<boolean>(player.status === "readyToPlay")

	if (status === "readyToPlay" && !hasLoadedOnce) {
		setHasLoadedOnce(true)
	}

	const videoViewStyle: ViewStyle = {
		width: dimensions.width,
		height: dimensions.height,
		paddingTop: headerHeight ? headerHeight + insets.top : 0,
		paddingBottom: insets.bottom,
		paddingLeft: insets.left,
		paddingRight: insets.right
	}

	return (
		<View
			className="bg-transparent"
			style={videoViewStyle}
		>
			<VideoView
				style={{
					width: "100%",
					height: "100%"
				}}
				player={player}
				contentFit="contain"
				nativeControls={true}
				allowsPictureInPicture={pipEnabled}
				// Android's native auto-enter only requires the view to be attached, NOT playing —
				// backgrounding over a PAUSED preview would pop a PiP window (and legitimately
				// suppress the biometric lock). iOS requires active playback natively. Gate Android
				// on isPlaying so both platforms mean "keep the video PLAYING in a window", matching
				// the settings copy (post-implementation review finding 4).
				startsPictureInPictureAutomatically={pipEnabled && (Platform.OS === "ios" || isPlaying)}
				// The Android fullscreen button launches a SEPARATE activity, which pauses
				// MainActivity → AppState "background" while the user is still watching — tearing
				// down the HTTP provider mid-playback and arming the biometric lock (spec §3a).
				// The preview is already full-screen; the button is redundant on Android.
				fullscreenOptions={{
					enable: Platform.OS === "ios"
				}}
				onPictureInPictureStart={() => {
					usePipStore.getState().setActiveKey(cacheKey)

					// A late PiP-start after the Android guard paused (start delivered after the
					// double-deferred check) — the window IS up, resume the guard's pause.
					if (guardPausedRef.current) {
						guardPausedRef.current = false

						try {
							player.play()
						} catch {
							// released natively already
						}
					}
				}}
				onPictureInPictureStop={() => {
					guardPausedRef.current = false

					usePipStore.getState().setActiveKey(prev => (prev === cacheKey ? null : prev))
				}}
			/>
			{status === "error" || !hasLoadedOnce ? <PreviewLoadingOverlay status={status === "error" ? "error" : "loading"} /> : null}
		</View>
	)
}

export default PreviewVideo
