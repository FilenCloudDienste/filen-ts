import { memo } from "react"
import ZoomableView from "@/components/ui/zoomableView"
import Image from "@/components/ui/image"
import { useWindowDimensions } from "react-native"
import { type SharedValue } from "react-native-reanimated"

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

		const imageStyle = {
			width: dimensions.width,
			height: dimensions.height
		}

		return (
			<ZoomableView
				style={[
					{
						flex: 1,
						alignItems: "center",
						justifyContent: "center"
					},
					imageStyle
				]}
				scaleValue={zoomScale}
				onPinchDismiss={onPinchDismiss}
				onZoomChange={onZoomChange}
				onSingleTap={onSingleTap}
				maxZoom={10}
			>
				<Image
					className="flex-1 bg-transparent"
					source={{
						uri: fileUrl
					}}
					contentFit="contain"
					cachePolicy="disk"
					style={imageStyle}
					recyclingKey={`preview-image-${fileUrl}`}
				/>
			</ZoomableView>
		)
	}
)

export default PreviewImage
