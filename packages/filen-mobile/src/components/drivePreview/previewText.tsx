import View from "@/components/ui/view"
import { getPreviewType } from "@/lib/previewType"
import TextEditor, { backgroundColors, type TextEditorDocumentStatus } from "@/components/textEditor"
import { MAX_TEXT_BYTES } from "@/components/textEditor/constants"
import { useShallow } from "zustand/shallow"
import useDrivePreviewStore from "@/stores/useDrivePreview.store"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { useResolveClassNames, useUniwind } from "uniwind"
import { ActivityIndicator, type ViewStyle } from "react-native"
import { type RangeSource } from "@/hooks/useRangeSource"
import { useTranslation } from "react-i18next"
import { useRecyclingState } from "@shopify/flash-list"
import { type GalleryItemTagged, galleryItemKey } from "@/components/drivePreview/gallery"
import { galleryItemRenderName } from "@/components/drivePreview/galleryRenderName"
import useEditableSave from "@/components/drivePreview/useEditableSave"
import PreviewSaveButton from "@/components/drivePreview/previewSaveButton"
import { PreviewStatusMessage } from "@/components/drivePreview/previewStatus"
import PreviewDocumentGate from "@/components/drivePreview/previewDocumentGate"

const PreviewTextInner = ({
	previewType,
	source,
	item,
	containerStyle
}: {
	previewType: "text" | "code"
	source: Extract<RangeSource, { status: "ready" }>
	item: GalleryItemTagged
	containerStyle: ViewStyle
}) => {
	const { t } = useTranslation()
	const headerHeight = useDrivePreviewStore(useShallow(state => state.headerHeight))
	const setContentScrolled = useDrivePreviewStore(useShallow(state => state.setContentScrolled))
	const insets = useSafeAreaInsets()
	const [status, setStatus] = useRecyclingState<TextEditorDocumentStatus | "loading">("loading", [galleryItemKey(item)])
	const { hasEdits, setHasEdits, saveHandleRef, readOnly, save, isOnline } = useEditableSave(item, {
		failed: "Text file save failed",
		notSerialised: "The file could not be saved"
	})

	// The editor's mode and highlighting follow the name the page opened with (galleryItemRenderName), never a
	// rename that would remount it under unsaved edits.
	const fileName = galleryItemRenderName(item)

	// Rendered-markdown parity with notes (Play review request): markdown files get the
	// markdown editor + the floating preview toggle instead of the plain code editor. One
	// shared toggle id for ALL drive markdown files — per-file ids would grow the persisted
	// toggle record with every file ever previewed, and "show rendered markdown" is a mode
	// preference, not a per-file one.
	const isMarkdownFile = /\.(md|markdown)$/i.test(fileName)

	return (
		<View
			className="flex-1"
			style={containerStyle}
		>
			{hasEdits && item.type === "drive" && (
				<PreviewSaveButton
					onPress={save}
					enabled={isOnline}
					top={headerHeight}
					insetRight={insets.right}
				/>
			)}
			<TextEditor
				// A new document always gets a new WebView, so the previous file's document is not a cost
				// this one pays.
				key={galleryItemKey(item)}
				onDocumentEditedChange={setHasEdits}
				onDocumentStatus={setStatus}
				onScrolledChange={setContentScrolled}
				readRange={source.readRange}
				fileSize={source.size}
				saveHandleRef={saveHandleRef}
				readOnly={readOnly}
				placeholder={t("placeholder")}
				type={isMarkdownFile ? "markdown" : previewType === "code" ? "code" : "text"}
				id={isMarkdownFile ? "drivePreview" : undefined}
				fileName={fileName}
				paddingTop={headerHeight ? headerHeight + 8 : undefined}
				paddingBottom={insets.bottom}
			/>
			{status !== "ready" && (
				<View
					className="absolute inset-0 items-center justify-center px-8"
					style={containerStyle}
				>
					{status === "loading" ? (
						<ActivityIndicator
							size="small"
							color="white"
						/>
					) : (
						<PreviewStatusMessage
							icon={status === "notText" ? "document-outline" : "warning-outline"}
							text={status === "notText" ? t("preview_not_text") : t("preview_load_failed")}
						/>
					)}
				</View>
			)}
		</View>
	)
}

const PreviewText = ({ item }: { item: GalleryItemTagged }) => {
	const { t } = useTranslation()
	const bgBackground = useResolveClassNames("bg-background")
	const { theme } = useUniwind()
	const previewType = getPreviewType(galleryItemRenderName(item))

	const containerStyle = {
		backgroundColor:
			previewType === "text" ? bgBackground.backgroundColor : backgroundColors["normal"][theme === "dark" ? "dark" : "light"]
	}

	return (
		<PreviewDocumentGate
			item={item}
			maxBytes={MAX_TEXT_BYTES}
			// No magic: text has no signature. Content that turns out not to be text is caught after decoding,
			// by the editor's binary-content gate.
			refusedText={{
				tooLarge: t("text_file_too_large"),
				other: t("preview_load_failed")
			}}
			style={containerStyle}
		>
			{source => (
				<PreviewTextInner
					previewType={previewType === "code" ? "code" : "text"}
					source={source}
					item={item}
					containerStyle={containerStyle}
				/>
			)}
		</PreviewDocumentGate>
	)
}

export default PreviewText
