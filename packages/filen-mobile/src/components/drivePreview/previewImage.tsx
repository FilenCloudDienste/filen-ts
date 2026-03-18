import { memo, useMemo } from "@/lib/memo"
import ZoomableView from "@/components/ui/zoomableView"
import Image from "@/components/ui/image"
import { useWindowDimensions, type ViewStyle } from "react-native"
import { type SharedValue } from "react-native-reanimated"
import type { ImageStyle, ImageSource } from "expo-image"

const ZOOMABLE_VIEW_STYLE: ViewStyle = {
	flex: 1,
	alignItems: "center",
	justifyContent: "center"
}

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

		const imageStyle = useMemo<ImageStyle>(
			() => ({
				width: dimensions.width,
				height: dimensions.height
			}),
			[dimensions.width, dimensions.height]
		)

		const imageSource = useMemo<ImageSource>(
			() => ({
				uri: fileUrl
			}),
			[fileUrl]
		)

		return (
			<ZoomableView
				style={[ZOOMABLE_VIEW_STYLE, imageStyle]}
				scaleValue={zoomScale}
				onPinchDismiss={onPinchDismiss}
				onZoomChange={onZoomChange}
				onSingleTap={onSingleTap}
				maxZoom={10}
			>
				<Image
					className="flex-1 bg-transparent"
					source={imageSource}
					contentFit="contain"
					cachePolicy="disk"
					style={imageStyle}
				/>
			</ZoomableView>
		)
	}
)

export default PreviewImage
