import { getPreviewType } from "@/lib/previewType"
import { useWindowDimensions, ActivityIndicator } from "react-native"
import { type SharedValue } from "react-native-reanimated"
import PreviewImage from "@/components/drivePreview/previewImage"
import PreviewRawImage from "@/components/drivePreview/previewRawImage"
import PreviewSvg from "@/components/drivePreview/previewSvg"
import PreviewVideo from "@/components/drivePreview/previewVideo"
import PreviewAudio from "@/components/drivePreview/previewAudio"
import PreviewText from "@/components/drivePreview/previewText"
import UnavailableOfflineNotice from "@/components/drivePreview/unavailableOfflineNotice"
import { useShallow } from "zustand/shallow"
import useDrivePreviewStore from "@/stores/useDrivePreview.store"
import useFileUrlQuery from "@/queries/useFileUrl.query"
import PreviewPdf from "@/components/drivePreview/previewPdf"
import PreviewDocx from "@/components/drivePreview/previewDocx"
import PreviewSlot from "@/components/drivePreview/previewSlot"
import View from "@/components/ui/view"
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
	const dimensions = useWindowDimensions()
	const isActive = useDrivePreviewStore(useShallow(state => state.currentIndex === info.index))

	const previewType = getPreviewType(info.item.type === "drive" ? (info.item.data.data.decryptedMeta?.name ?? "") : info.item.data.name)

	const fileUrlQuery = useFileUrlQuery(
		info.item.type === "drive"
			? {
					type: "drive",
					data: {
						uuid: info.item.data.data.uuid,
						// Thread the held item by value so a cross-directory search hit (not in
						// the global uuid cache) still resolves its bytes.
						item: info.item.data
					}
				}
			: {
					type: "external",
					data: {
						url: info.item.data.url,
						name: info.item.data.name
					}
				},
		{
			// A RAW file's bytes are never rendered (PreviewRawImage shows the SDK-extracted JPEG):
			// resolving a URL for them would block on the HTTP provider and report "unavailable
			// offline" even when a preview is cached.
			enabled: previewType !== "rawImage"
		}
	)

	const fileUrl = fileUrlQuery.status === "success" ? fileUrlQuery.data : null

	const itemStyle = {
		width: dimensions.width,
		height: dimensions.height
	}

	if (previewType === "rawImage" && info.item.type === "drive") {
		// Inside PreviewSlot so a neighbouring page never triggers a 2–10 MB extraction.
		return (
			<View
				className="bg-transparent"
				style={itemStyle}
			>
				<PreviewSlot isActive={isActive}>
					<PreviewRawImage
						item={info.item.data}
						isActive={isActive}
						zoomScale={galleryZoomScale}
						onPinchDismiss={goBack}
						onZoomChange={onZoomChange}
						onSingleTap={onSingleTap}
						onPinchActiveChange={onPinchActiveChange}
					/>
				</PreviewSlot>
			</View>
		)
	}

	// Resolver succeeded but produced no URL — happens when the device is
	// offline AND the item is in neither the offline store nor the file cache.
	// Render an explicit "unavailable offline" state instead of an indefinite spinner.
	if (fileUrlQuery.status === "success" && fileUrl === null && previewType !== "unknown") {
		return <UnavailableOfflineNotice style={itemStyle} />
	}

	if (!fileUrl || previewType === "unknown" || previewType === "rawImage") {
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

		case "svg": {
			// Rendered via react-native-svg rather than expo-image — expo-image decodes SVG
			// through the unmaintained androidsvg 1.4 on Android, which can recurse into an
			// uncatchable native OOM abort on adversarial/complex SVGs. See PreviewSvg.
			//
			// Gated on focus like the other heavy types: react-native-svg draws on the UI thread,
			// and FlashList lays out a screen-width of neighbours ahead of the viewport, so an
			// unfocused SVG would otherwise run a full native draw pass for a page the reader has
			// not opened — paying its cost, and taking any native draw fault, on the way past.
			return (
				<View
					className="bg-transparent"
					style={itemStyle}
				>
					<PreviewSlot isActive={isActive}>
						<PreviewSvg
							item={info.item}
							zoomScale={galleryZoomScale}
							onPinchDismiss={goBack}
							onZoomChange={onZoomChange}
							onSingleTap={onSingleTap}
							onPinchActiveChange={onPinchActiveChange}
						/>
					</PreviewSlot>
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
			// Every PreviewType has a renderer above; a new member fails to compile here rather than
			// rendering an empty page.
			return previewType satisfies never
		}
	}
}

export default GalleryItem
