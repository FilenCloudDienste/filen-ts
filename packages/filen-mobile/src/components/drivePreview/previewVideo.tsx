import { useState } from "react"
import { useWindowDimensions, type ViewStyle } from "react-native"
import { VideoView } from "expo-video"
import { useEvent } from "expo"
import useDrivePreviewStore from "@/stores/useDrivePreview.store"
import { useShallow } from "zustand/shallow"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import View from "@/components/ui/view"
import PreviewLoadingOverlay from "@/components/drivePreview/previewLoadingOverlay"
import galleryVideoPlayers from "@/components/drivePreview/galleryVideoPlayers"

const PreviewVideo = ({ cacheKey, fileUrl }: { cacheKey: string; fileUrl: string }) => {
	const dimensions = useWindowDimensions()
	const headerHeight = useDrivePreviewStore(useShallow(state => state.headerHeight))
	const insets = useSafeAreaInsets()

	// Session-owned player (get-or-create, render-idempotent): survives the
	// rotation remount of the carousel so playback continues uninterrupted.
	const player = galleryVideoPlayers.acquire({
		key: cacheKey,
		fileUrl
	})

	const { status } = useEvent(player, "statusChange", {
		status: player.status
	})

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
				allowsPictureInPicture={false}
			/>
			{status === "error" || !hasLoadedOnce ? <PreviewLoadingOverlay status={status === "error" ? "error" : "loading"} /> : null}
		</View>
	)
}

export default PreviewVideo
