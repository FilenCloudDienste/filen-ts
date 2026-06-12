import { useTranslation } from "react-i18next"
import { getPreviewType } from "@/lib/previewType"
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
import PreviewSlot from "@/components/drivePreview/previewSlot"
import View from "@/components/ui/view"
import Text from "@/components/ui/text"
import Ionicons from "@expo/vector-icons/Ionicons"
import { type ListRenderItemInfo } from "@shopify/flash-list"
import { type GalleryItemTagged, galleryItemKey } from "@/components/drivePreview/gallery"

const GalleryItem = ({
	info,
	galleryZoomScale,
	goBack,
	onZoomChange,
	onSingleTap,
	onPinchActiveChange
}: {
	info: ListRenderItemInfo<GalleryItemTagged>
	galleryZoomScale: SharedValue<number>
	goBack: () => void
	onZoomChange?: (zoom: number) => void
	onSingleTap?: () => void
	onPinchActiveChange?: (active: boolean) => void
}) => {
	const { t } = useTranslation()
	const dimensions = useWindowDimensions()
	const isActive = useDrivePreviewStore(useShallow(state => state.currentIndex === info.index))

	const previewType = getPreviewType(info.item.type === "drive" ? (info.item.data.data.decryptedMeta?.name ?? "") : info.item.data.name)

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

	// Resolver succeeded but produced no URL — happens when the device is
	// offline AND the item is in neither the offline store nor the file cache.
	// Render an explicit "unavailable offline" state instead of an indefinite spinner.
	if (fileUrlQuery.status === "success" && fileUrl === null && previewType !== "unknown") {
		return (
			<View
				className="bg-transparent"
				style={itemStyle}
			>
				<View className="bg-transparent flex-1 items-center justify-center px-8">
					<Ionicons
						name="cloud-offline-outline"
						size={48}
						color="#9ca3af"
					/>
					<Text className="mt-4 text-center text-sm leading-5 text-muted-foreground">{t("unavailable_offline")}</Text>
				</View>
			</View>
		)
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
						onPinchActiveChange={onPinchActiveChange}
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
					<PreviewSlot isActive={isActive}>
						<PreviewPdf item={info.item} />
					</PreviewSlot>
				</View>
			)
		}

		case "docx": {
			return (
				<View
					className="bg-transparent"
					style={itemStyle}
				>
					<PreviewSlot isActive={isActive}>
						<PreviewDocx item={info.item} />
					</PreviewSlot>
				</View>
			)
		}

		case "video": {
			return (
				<View
					className="bg-transparent"
					style={itemStyle}
				>
					<PreviewSlot isActive={isActive}>
						<PreviewVideo
							cacheKey={galleryItemKey(info.item)}
							fileUrl={fileUrl}
						/>
					</PreviewSlot>
				</View>
			)
		}

		case "audio": {
			return (
				<View
					className="bg-transparent"
					style={itemStyle}
				>
					<PreviewSlot isActive={isActive}>
						<PreviewAudio
							item={info.item}
							fileUrl={fileUrl}
						/>
					</PreviewSlot>
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
					<PreviewSlot isActive={isActive}>
						<PreviewText item={info.item} />
					</PreviewSlot>
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

export default GalleryItem
