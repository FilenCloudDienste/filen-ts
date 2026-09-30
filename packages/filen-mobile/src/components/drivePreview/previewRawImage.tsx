import { useTranslation } from "react-i18next"
import { ActivityIndicator } from "react-native"
import { type SharedValue } from "react-native-reanimated"
import useRawPreviewQuery from "@/queries/useRawPreview.query"
import PreviewImage from "@/components/drivePreview/previewImage"
import UnavailableOfflineNotice from "@/components/drivePreview/unavailableOfflineNotice"
import PreviewLoadFailedNotice from "@/components/drivePreview/previewLoadFailedNotice"
import ListEmpty from "@/components/ui/listEmpty"
import View from "@/components/ui/view"
import { type GalleryItemTagged } from "@/components/drivePreview/gallery"

// A RAW camera file's own bytes are never rendered: the page shows the JPEG the SDK extracts from
// the container (2–10 MB for a CR3 full-size track), so the extraction runs only for the page on
// screen — the caller mounts this inside PreviewSlot and the query is enabled on isActive. Renders
// into galleryItem's window-sized cell, so no wrapper of its own.
const PreviewRawImage = ({
	item,
	isActive,
	zoomScale,
	onPinchDismiss,
	onZoomChange,
	onSingleTap,
	onPinchActiveChange
}: {
	item: Extract<GalleryItemTagged, { type: "drive" }>["data"]
	isActive: boolean
	zoomScale: SharedValue<number>
	onPinchDismiss: () => void
	onZoomChange?: (zoom: number) => void
	onSingleTap?: () => void
	onPinchActiveChange?: (active: boolean) => void
}) => {
	const { t } = useTranslation()

	const rawPreviewQuery = useRawPreviewQuery(
		{
			type: "drive",
			data: {
				uuid: item.data.uuid,
				// By value, so a cross-directory search hit (not in the global uuid cache) resolves.
				item
			}
		},
		{
			enabled: isActive
		}
	)

	if (rawPreviewQuery.status === "error") {
		// Transport failure during extraction — the shared notice with its explicit Retry.
		return (
			<PreviewLoadFailedNotice
				className="bg-transparent"
				onRetry={() => rawPreviewQuery.refetch()}
			/>
		)
	}

	if (rawPreviewQuery.status !== "success") {
		return (
			<View className="bg-transparent flex-1 items-center justify-center">
				<ActivityIndicator
					size="small"
					color="white"
				/>
			</View>
		)
	}

	switch (rawPreviewQuery.data.kind) {
		case "uri": {
			// expo-image honours the EXIF orientation the SDK splices into the extracted JPEG.
			return (
				<PreviewImage
					fileUrl={rawPreviewQuery.data.uri}
					zoomScale={zoomScale}
					onPinchDismiss={onPinchDismiss}
					onZoomChange={onZoomChange}
					onSingleTap={onSingleTap}
					onPinchActiveChange={onPinchActiveChange}
				/>
			)
		}

		case "noPreview": {
			// The container embeds no JPEG a viewer could show — the gallery's own empty state, title
			// only (no_preview_description is the empty-GALLERY subtitle: "There's nothing here to preview.").
			return (
				<ListEmpty
					icon="eye-off-outline"
					title={t("no_preview")}
				/>
			)
		}

		case "offline": {
			return <UnavailableOfflineNotice />
		}

		default: {
			return rawPreviewQuery.data satisfies never
		}
	}
}

export default PreviewRawImage
