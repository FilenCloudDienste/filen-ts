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
import { PreviewSpinner } from "@/components/drivePreview/previewStatus"
import View from "@/components/ui/view"
import { type ListRenderItemInfo } from "@shopify/flash-list"
import { type GalleryItemTagged, galleryItemKey } from "@/components/drivePreview/gallery"
import { galleryItemPreviewType, galleryItemFileSource, galleryItemNeedsSniff } from "@/components/drivePreview/galleryRenderName"
import TransportStreamGate from "@/components/drivePreview/transportStreamGate"
import useGalleryDimensions from "@/components/drivePreview/useGalleryDimensions"
import ListEmpty from "@/components/ui/listEmpty"
import { verdictFileOf } from "@/lib/previewType"
import { useTranslation } from "react-i18next"

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
	const dimensions = useGalleryDimensions()
	const isActive = useDrivePreviewStore(useShallow(state => state.currentIndex === info.index))

	// By the name and verdict the page opened with: a rename elsewhere keeps the renderer, and an editor's
	// unsaved edits; a verdict a player records meanwhile never swaps it.
	const previewType = galleryItemPreviewType(info.item)
	const needsSniff = galleryItemNeedsSniff(info.item)
	const rendersFromUrl = previewType === "image" || previewType === "video"

	const fileUrlQuery = useFileUrlQuery(galleryItemFileSource(info.item), {
		// Only image and video render from a URL, and the `.ts` gate of the page on screen reads its head
		// through one. Every other type reads its own bytes (audio resolves its URL once its tags have
		// pulled the file local), so resolving one here would only hold that read back behind an
		// HTTP-provider wait.
		enabled: rendersFromUrl || (needsSniff && isActive)
	})

	const fileUrl = fileUrlQuery.status === "success" ? fileUrlQuery.data : null

	const itemStyle = {
		width: dimensions.width,
		height: dimensions.height
	}

	const spinner = <PreviewSpinner className="bg-transparent" />

	const renderPage = () => {
		if (needsSniff && info.item.type === "drive") {
			return (
				<PreviewSlot isActive={isActive}>
					<TransportStreamGate
						item={info.item.data}
						fileUrlQuery={fileUrlQuery}
					/>
				</PreviewSlot>
			)
		}

		if (previewType === "rawImage" && info.item.type === "drive") {
			// Inside PreviewSlot so a neighbouring page never triggers a 2–10 MB extraction.
			return (
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
			)
		}

		switch (previewType) {
			case "unknown": {
				// A drive file only reaches here as a transport stream the platform does not play (iOS).
				return info.item.type === "drive" ? (
					<ListEmpty
						icon="eye-off-outline"
						title={t("no_preview")}
					/>
				) : (
					spinner
				)
			}

			case "rawImage": {
				return spinner
			}

			case "image":
			case "video": {
				if (fileUrl === null) {
					// Resolver succeeded but produced no URL — happens when the device is offline AND the
					// item is in neither the offline store nor the file cache. An explicit "unavailable
					// offline" state instead of an indefinite spinner.
					return fileUrlQuery.status === "success" ? <UnavailableOfflineNotice /> : spinner
				}

				if (previewType === "image") {
					return (
						<PreviewImage
							fileUrl={fileUrl}
							zoomScale={galleryZoomScale}
							onPinchDismiss={goBack}
							onZoomChange={onZoomChange}
							onSingleTap={onSingleTap}
							onPinchActiveChange={onPinchActiveChange}
						/>
					)
				}

				return (
					<PreviewSlot isActive={isActive}>
						<PreviewVideo
							cacheKey={galleryItemKey(info.item)}
							fileUrl={fileUrl}
							file={info.item.type === "drive" ? verdictFileOf(info.item.data) : undefined}
						/>
					</PreviewSlot>
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
				)
			}

			case "pdf": {
				return (
					<PreviewSlot isActive={isActive}>
						<PreviewPdf item={info.item} />
					</PreviewSlot>
				)
			}

			case "docx": {
				return (
					<PreviewSlot isActive={isActive}>
						<PreviewDocx item={info.item} />
					</PreviewSlot>
				)
			}

			case "audio": {
				return (
					<PreviewSlot isActive={isActive}>
						<PreviewAudio item={info.item} />
					</PreviewSlot>
				)
			}

			case "text":
			case "code": {
				return (
					<PreviewSlot isActive={isActive}>
						<PreviewText item={info.item} />
					</PreviewSlot>
				)
			}

			default: {
				// Every PreviewType has a renderer above; a new member fails to compile here rather than
				// rendering an empty page.
				return previewType satisfies never
			}
		}
	}

	// The one window-sized cell per page; every renderer above fills it via flex-1 or explicit size.
	return (
		<View
			className="bg-transparent"
			style={itemStyle}
		>
			{renderPage()}
		</View>
	)
}

export default GalleryItem
