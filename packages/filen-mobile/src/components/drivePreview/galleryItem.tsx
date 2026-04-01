import { memo } from "react"
import { type DriveItemFileExtracted } from "@/types"
import { getPreviewType } from "@/lib/utils"
import useHttpStore from "@/stores/useHttp.store"
import { useWindowDimensions, ActivityIndicator } from "react-native"
import { type SharedValue } from "react-native-reanimated"
import { type ListRenderItemInfo } from "@shopify/flash-list"
import PreviewImage from "@/components/drivePreview/previewImage"
import PreviewVideo from "@/components/drivePreview/previewVideo"
import PreviewAudio from "@/components/drivePreview/previewAudio"
import PreviewText from "@/components/drivePreview/previewText"
import { useShallow } from "zustand/shallow"
import useDrivePreviewStore from "@/stores/useDrivePreview.store"
import { AnyFile } from "@filen/sdk-rs"
import PreviewPdf from "@/components/drivePreview/previewPdf"
import PreviewDocx from "@/components/drivePreview/previewDocx"
import View from "@/components/ui/view"

function getFileUrlForItem(item: DriveItemFileExtracted, getFileUrl: (file: AnyFile) => string): string | null {
	try {
		switch (item.type) {
			case "file": {
				return getFileUrl(new AnyFile.File(item.data))
			}

			case "sharedFile":
			case "sharedRootFile": {
				return getFileUrl(new AnyFile.Shared(item.data))
			}
		}
	} catch (e) {
		console.error(e)

		return null
	}
}

const GalleryItem = memo(
	({
		info,
		galleryZoomScale,
		goBack,
		onZoomChange,
		onSingleTap
	}: {
		info: ListRenderItemInfo<DriveItemFileExtracted>
		galleryZoomScale: SharedValue<number>
		goBack: () => void
		onZoomChange?: (zoom: number) => void
		onSingleTap?: () => void
	}) => {
		const dimensions = useWindowDimensions()
		const getFileUrl = useHttpStore(useShallow(state => state.getFileUrl))
		const isActive = useDrivePreviewStore(useShallow(state => state.currentIndex === info.index))

		const previewType = getPreviewType(info.item.data.decryptedMeta?.name ?? "")
		const fileUrl = !getFileUrl ? null : getFileUrlForItem(info.item, getFileUrl)

		const itemStyle = {
			width: dimensions.width,
			height: dimensions.height
		}

		if (!fileUrl || !previewType || previewType === "unknown") {
			return (
				<View
					className="bg-transparent"
					style={itemStyle}
				/>
			)
		}

		switch (previewType) {
			case "image": {
				return (
					<View
						className="bg-transparent"
						style={itemStyle}
					>
						<PreviewImage
							fileUrl={fileUrl}
							zoomScale={galleryZoomScale}
							onPinchDismiss={goBack}
							onZoomChange={onZoomChange}
							onSingleTap={onSingleTap}
						/>
					</View>
				)
			}

			case "pdf": {
				return (
					<View
						className="bg-transparent"
						style={itemStyle}
					>
						{isActive ? (
							<PreviewPdf item={info.item} />
						) : (
							<View className="bg-transparent flex-1 items-center justify-center">
								<ActivityIndicator
									size="small"
									color="white"
								/>
							</View>
						)}
					</View>
				)
			}

			case "docx": {
				return (
					<View
						className="bg-transparent"
						style={itemStyle}
					>
						{isActive ? (
							<PreviewDocx item={info.item} />
						) : (
							<View className="bg-transparent flex-1 items-center justify-center">
								<ActivityIndicator
									size="small"
									color="white"
								/>
							</View>
						)}
					</View>
				)
			}

			case "video": {
				return (
					<View
						className="bg-transparent"
						style={itemStyle}
					>
						{isActive ? (
							<PreviewVideo fileUrl={fileUrl} />
						) : (
							<View className="bg-transparent flex-1 items-center justify-center">
								<ActivityIndicator
									size="small"
									color="white"
								/>
							</View>
						)}
					</View>
				)
			}

			case "audio": {
				return (
					<View
						className="bg-transparent"
						style={itemStyle}
					>
						{isActive ? (
							<PreviewAudio item={info.item} />
						) : (
							<View className="bg-transparent flex-1 items-center justify-center">
								<ActivityIndicator
									size="small"
									color="white"
								/>
							</View>
						)}
					</View>
				)
			}

			case "text":
			case "code": {
				return (
					<View
						className="bg-transparent"
						style={itemStyle}
					>
						{isActive ? (
							<PreviewText item={info.item} />
						) : (
							<View className="bg-transparent flex-1 items-center justify-center">
								<ActivityIndicator
									size="small"
									color="white"
								/>
							</View>
						)}
					</View>
				)
			}

			default: {
				return (
					<View
						className="bg-transparent"
						style={itemStyle}
					/>
				)
			}
		}
	}
)

export default GalleryItem
