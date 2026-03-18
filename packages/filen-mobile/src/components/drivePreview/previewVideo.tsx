import { memo, useMemo } from "@/lib/memo"
import { useWindowDimensions, type ViewStyle } from "react-native"
import { VideoView, useVideoPlayer } from "expo-video"
import useDrivePreviewStore from "@/stores/useDrivePreview.store"
import { useShallow } from "zustand/shallow"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import View from "@/components/ui/view"

const PreviewVideo = memo(({ fileUrl }: { fileUrl: string }) => {
	const dimensions = useWindowDimensions()
	const headerHeight = useDrivePreviewStore(useShallow(state => state.headerHeight))
	const insets = useSafeAreaInsets()

	const player = useVideoPlayer(fileUrl, p => {
		p.loop = false

		p.play()
	})

	const videoViewStyle = useMemo<ViewStyle>(
		() => ({
			width: dimensions.width,
			height: dimensions.height,
			paddingTop: headerHeight ? headerHeight + insets.top : 0,
			paddingBottom: insets.bottom
		}),
		[dimensions.width, dimensions.height, headerHeight, insets.top, insets.bottom]
	)

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
		</View>
	)
})

export default PreviewVideo
