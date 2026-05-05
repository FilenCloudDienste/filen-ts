import { memo } from "react"
import { getPreviewType } from "@/lib/utils"
import { useWindowDimensions, ActivityIndicator } from "react-native"
import { type SharedValue } from "react-native-reanimated"
import PreviewImage from "@/components/drivePreview/previewImage"
import PreviewVideo from "@/components/drivePreview/previewVideo"
import PreviewAudio from "@/components/drivePreview/previewAudio"
import PreviewText from "@/components/drivePreview/previewText"
import { useShallow } from "zustand/shallow"
import useDrivePreviewStore from "@/stores/useDrivePreview.store"
import useFileUrlQuery from "@/queries/useFileUrl.query"
import PreviewPdf from "@/components/drivePreview/previewPdf"
import PreviewDocx from "@/components/drivePreview/previewDocx"
import View from "@/components/ui/view"
import type { ListRenderItemInfo } from "@shopify/flash-list"
import type { GalleryItemTagged } from "@/components/drivePreview/gallery"

const GalleryItem = memo(
	({
		info,
		galleryZoomScale,
		goBack,
		onZoomChange,
		onSingleTap
	}: {
		info: ListRenderItemInfo<GalleryItemTagged>
		galleryZoomScale: SharedValue<number>
		goBack: () => void
		onZoomChange?: (zoom: number) => void
		onSingleTap?: () => void
	}) => {
		const dimensions = useWindowDimensions()
		const isActive = useDrivePreviewStore(useShallow(state => state.currentIndex === info.index))

		const previewType = getPreviewType(
			info.item.type === "drive" ? (info.item.data.data.decryptedMeta?.name ?? "") : info.item.data.name
		)

		const fileUrlQuery = useFileUrlQuery(
			info.item.type === "drive"
				? {
						type: "drive",
						data: {
							uuid: info.item.data.data.uuid
						}
					}
				: {
						type: "external",
						data: {
							url: info.item.data.url,
							name: info.item.data.name
						}
					}
		)

		const fileUrl = fileUrlQuery.status === "success" ? fileUrlQuery.data : null

		const itemStyle = {
			width: dimensions.width,
			height: dimensions.height
		}

		if (!fileUrl || previewType === "unknown") {
			return (
				<View
					className="bg-transparent"
					style={itemStyle}
				>
					<View className="bg-transparent flex-1 items-center justify-center">
						<ActivityIndicator
							size="small"
							color="white"
						/>
					</View>
				</View>
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
							<PreviewAudio
								item={info.item}
								fileUrl={fileUrl}
							/>
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
