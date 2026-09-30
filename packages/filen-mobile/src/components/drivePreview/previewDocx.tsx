import View from "@/components/ui/view"
import DocxPreview from "@/components/docxPreview"
import { MAX_DOCX_BYTES } from "@/components/docxPreview/constants"
import { useShallow } from "zustand/shallow"
import useDrivePreviewStore from "@/stores/useDrivePreview.store"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { ZIP_MAGIC } from "@/lib/rangeTransfer"
import { useTranslation } from "react-i18next"
import { galleryItemKey, type GalleryItemTagged } from "@/components/drivePreview/gallery"
import PreviewDocumentGate from "@/components/drivePreview/previewDocumentGate"

const PreviewDocx = ({ item }: { item: GalleryItemTagged }) => {
	const { t } = useTranslation()
	const headerHeight = useDrivePreviewStore(useShallow(state => state.headerHeight))
	const insets = useSafeAreaInsets()

	return (
		<PreviewDocumentGate
			item={item}
			maxBytes={MAX_DOCX_BYTES}
			// A .docx is a zip, so the header check is on the archive signature rather than on anything
			// Office-specific — enough to tell a renamed file from a document before the renderer sees it.
			magic={ZIP_MAGIC}
			refusedText={{
				tooLarge: t("document_too_large"),
				wrongFormat: t("invalid_document"),
				other: t("preview_load_failed")
			}}
		>
			{source => (
				<View className="bg-background flex-1">
					<DocxPreview
						// A new document always gets a new WebView. Reusing one is what makes the previous
						// document's retained DOM a cost the next one pays.
						key={galleryItemKey(item)}
						readRange={source.readRange}
						fileSize={source.size}
						paddingTop={headerHeight ? headerHeight : undefined}
						paddingBottom={insets.bottom}
					/>
				</View>
			)}
		</PreviewDocumentGate>
	)
}

export default PreviewDocx
