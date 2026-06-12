import ZoomableView from "@/components/ui/zoomableView"
import Image from "@/components/ui/image"
import View from "@/components/ui/view"
import PreviewLoadingOverlay from "@/components/drivePreview/previewLoadingOverlay"
import { useState } from "react"
import { useWindowDimensions } from "react-native"
import { type SharedValue } from "react-native-reanimated"

const PreviewImage = ({
	fileUrl,
	zoomScale,
	onPinchDismiss,
	onZoomChange,
	onSingleTap,
	onPinchActiveChange
}: {
	fileUrl: string
	zoomScale: SharedValue<number>
	onPinchDismiss: () => void
	onZoomChange?: (zoom: number) => void
	onSingleTap?: () => void
	onPinchActiveChange?: (active: boolean) => void
}) => {
	const dimensions = useWindowDimensions()
	const [loadStatus, setLoadStatus] = useState<"loading" | "loaded" | "error">("loading")
	const [contentSize, setContentSize] = useState<{ width: number; height: number } | null>(null)
	const [prevFileUrl, setPrevFileUrl] = useState<string>(fileUrl)

	if (fileUrl !== prevFileUrl) {
		setPrevFileUrl(fileUrl)
		setLoadStatus("loading")
		setContentSize(null)
	}

	const imageStyle = {
		width: dimensions.width,
		height: dimensions.height
	}

	return (
		<View
			className="bg-transparent"
			style={imageStyle}
		>
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
				onPinchActiveChange={onPinchActiveChange}
				contentSize={contentSize ?? undefined}
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
					onLoad={e =>
						setContentSize({
							width: e.source.width,
							height: e.source.height
						})
					}
					onDisplay={() => setLoadStatus("loaded")}
					onError={() => setLoadStatus("error")}
				/>
			</ZoomableView>
			{loadStatus !== "loaded" ? <PreviewLoadingOverlay status={loadStatus} /> : null}
		</View>
	)
}

export default PreviewImage
