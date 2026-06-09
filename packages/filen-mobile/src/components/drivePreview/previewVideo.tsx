import { useWindowDimensions, type ViewStyle } from "react-native"
import { VideoView, useVideoPlayer } from "expo-video"
import { useEvent } from "expo"
import useDrivePreviewStore from "@/stores/useDrivePreview.store"
import { useShallow } from "zustand/shallow"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import View from "@/components/ui/view"
import PreviewLoadingOverlay from "@/components/drivePreview/previewLoadingOverlay"

const PreviewVideo = ({ fileUrl }: { fileUrl: string }) => {
	const dimensions = useWindowDimensions()
	const headerHeight = useDrivePreviewStore(useShallow(state => state.headerHeight))
	const insets = useSafeAreaInsets()

	const player = useVideoPlayer(fileUrl, p => {
		p.loop = false
		p.staysActiveInBackground = false

		p.play()
	})

	const { status } = useEvent(player, "statusChange", {
		status: player.status
	})

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
			{status !== "readyToPlay" ? <PreviewLoadingOverlay status={status === "error" ? "error" : "loading"} /> : null}
		</View>
	)
}

export default PreviewVideo
