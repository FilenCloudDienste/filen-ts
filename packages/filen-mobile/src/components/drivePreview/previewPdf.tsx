import { useTranslation } from "react-i18next"
import { useShallow } from "zustand/shallow"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import View from "@/components/ui/view"
import PdfPreview from "@/components/pdfPreview"
import { MAX_PDF_BYTES } from "@/components/pdfPreview/constants"
import { PDF_MAGIC } from "@/lib/rangeTransfer"
import useDrivePreviewStore from "@/stores/useDrivePreview.store"
import { galleryItemKey, type GalleryItemTagged } from "@/components/drivePreview/gallery"
import useEditableSave from "@/components/drivePreview/useEditableSave"
import PreviewSaveButton from "@/components/drivePreview/previewSaveButton"
import PreviewDocumentGate from "@/components/drivePreview/previewDocumentGate"

const PreviewPdf = ({ item }: { item: GalleryItemTagged }) => {
	const { t } = useTranslation()
	const headerHeight = useDrivePreviewStore(useShallow(state => state.headerHeight))
	const insets = useSafeAreaInsets()
	const { hasEdits, setHasEdits, saveHandleRef, readOnly, save, isOnline } = useEditableSave(item, {
		failed: "PDF save failed",
		notSerialised: "The document could not be saved"
	})

	return (
		<PreviewDocumentGate
			item={item}
			maxBytes={MAX_PDF_BYTES}
			magic={PDF_MAGIC}
			refusedText={{
				tooLarge: t("pdf_too_large"),
				wrongFormat: t("invalid_pdf"),
				other: t("unable_to_load_pdf")
			}}
		>
			{source => (
				<View className="bg-background flex-1">
					{hasEdits && !readOnly && (
						<PreviewSaveButton
							onPress={save}
							enabled={isOnline}
							top={headerHeight}
							insetRight={insets.right}
						/>
					)}
					<PdfPreview
						// A new document always gets a new WebView. Reusing one is what makes the previous
						// document's retained buffer a cost the next one pays. The password is deliberately NOT
						// part of this key — it arrives as a prop and must not remount the viewer.
						key={galleryItemKey(item)}
						readRange={source.readRange}
						fileSize={source.size}
						readOnly={readOnly}
						onEditedChange={setHasEdits}
						saveHandleRef={saveHandleRef}
						paddingTop={headerHeight ? headerHeight : undefined}
						paddingBottom={insets.bottom}
					/>
				</View>
			)}
		</PreviewDocumentGate>
	)
}

export default PreviewPdf
