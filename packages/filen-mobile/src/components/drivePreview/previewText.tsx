import { useEffect, useRef } from "react"
import View, { CrossGlassContainerView } from "@/components/ui/view"
import Text from "@/components/ui/text"
import { unwrapFileMeta, unwrappedFileIntoDriveItem } from "@/lib/sdkUnwrap"
import { getPreviewType } from "@/lib/previewType"
import TextEditor, { backgroundColors, type TextEditorDocumentStatus } from "@/components/textEditor"
import { MAX_TEXT_BYTES } from "@/components/textEditor/constants"
import { useShallow } from "zustand/shallow"
import useDrivePreviewStore from "@/stores/useDrivePreview.store"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { useResolveClassNames, useUniwind } from "uniwind"
import { ActivityIndicator, Platform } from "react-native"
import useFileUriQuery from "@/queries/useFileUri.query"
import useRangeSource, { type RangeSource } from "@/hooks/useRangeSource"
import { useTranslation } from "react-i18next"
import { PressableScale } from "@/components/ui/pressables"
import Ionicons from "@expo/vector-icons/Ionicons"
import transfers from "@/features/transfers/transfers"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import alerts from "@/lib/alerts"
import { useRecyclingState } from "@shopify/flash-list"
import { AnyDirWithContext_Tags } from "@filen/sdk-rs"
import { type GalleryItemTagged, galleryItemKey } from "@/components/drivePreview/gallery"
import useEditableTarget from "@/components/drivePreview/useEditableTarget"
import useIsOnline from "@/hooks/useIsOnline"
import logger from "@/lib/logger"
import type { File } from "expo-file-system"

const PreviewTextInner = ({
	previewType,
	source,
	item
}: {
	previewType: "text" | "code"
	source: Extract<RangeSource, { status: "ready" }>
	item: GalleryItemTagged
}) => {
	const { t } = useTranslation()
	const bgBackground = useResolveClassNames("bg-background")
	const { theme } = useUniwind()
	const headerHeight = useDrivePreviewStore(useShallow(state => state.headerHeight))
	const insets = useSafeAreaInsets()
	const [hasEdits, setHasEdits] = useRecyclingState<boolean>(false, [galleryItemKey(item)])
	const [status, setStatus] = useRecyclingState<TextEditorDocumentStatus | "loading">("loading", [galleryItemKey(item)])
	const textPrimary = useResolveClassNames("text-primary")
	const isOnline = useIsOnline()
	const { itemToUse, parent, readOnly, applySaved } = useEditableTarget(item)
	const saveHandleRef = useRef<(() => Promise<File | null>) | null>(null)
	const savingRef = useRef<boolean>(false)

	const fileName = item.type === "drive" ? item.data.data.decryptedMeta?.name : item.data.name

	// Rendered-markdown parity with notes (Play review request): markdown files get the
	// markdown editor + the floating preview toggle instead of the plain code editor. One
	// shared toggle id for ALL drive markdown files — per-file ids would grow the persisted
	// toggle record with every file ever previewed, and "show rendered markdown" is a mode
	// preference, not a per-file one.
	const isMarkdownFile = /\.(md|markdown)$/i.test(fileName ?? "")

	const save = async (): Promise<boolean> => {
		// See previewPdf: the loading overlay presents asynchronously and the unsaved-changes prompt
		// renders above it, so re-entry is reachable without a race. Two concurrent saves share one
		// write target.
		if (savingRef.current || !hasEdits || readOnly || !isOnline) {
			return false
		}

		savingRef.current = true

		try {
			return await runSave()
		} finally {
			savingRef.current = false
		}
	}

	const runSave = async (): Promise<boolean> => {
		const result = await runWithLoading(async defer => {
			if (!itemToUse?.data.decryptedMeta) {
				throw new Error("Missing decryptedMeta")
			}

			if (!parent || parent === "sharedInRoot" || parent.tag !== AnyDirWithContext_Tags.Normal) {
				throw new Error("Missing parent directory")
			}

			// Serialised by the editor into a temp file — the document never crosses the bridge whole.
			const savedFile = await saveHandleRef.current?.()

			if (!savedFile) {
				throw new Error("The file could not be saved")
			}

			defer(() => {
				if (savedFile.exists) {
					savedFile.delete()
				}
			})

			return await transfers.upload({
				localFileOrDir: savedFile,
				parent: parent.inner[0],
				name: itemToUse.data.decryptedMeta.name,
				modified: Date.now(),
				created: itemToUse.data.decryptedMeta.created != null ? Number(itemToUse.data.decryptedMeta.created) : undefined,
				mime: itemToUse.data.decryptedMeta.mime
			})
		})

		if (!result.success) {
			logger.error("drivePreview", "Text file save failed", {
				error: result.error
			})

			alerts.error(result.error)

			return false
		}

		if (!result.data) {
			return false
		}

		setHasEdits(false)

		const newFile = result.data.files[0]

		if (newFile) {
			const newDriveItem = unwrappedFileIntoDriveItem(unwrapFileMeta(newFile))

			if (newDriveItem.type === "file") {
				applySaved(newDriveItem)
			}
		}

		return true
	}

	// Publish the dirty flag so the route-level unsaved-changes guard can prompt on navigate-away.
	useEffect(() => {
		useDrivePreviewStore.getState().setHasUnsavedEdits(hasEdits && !readOnly)
	}, [hasEdits, readOnly])

	// save() is re-created each render; keep the latest in a ref and publish ONE stable wrapper so the
	// guard can save-then-leave. Clear the handle + flag on unmount so a later preview cannot inherit
	// this item's dirty state.
	const saveRef = useRef(save)

	useEffect(() => {
		saveRef.current = save
	})

	useEffect(() => {
		useDrivePreviewStore.getState().setSaveEdits(() => saveRef.current())

		return () => {
			useDrivePreviewStore.getState().setSaveEdits(null)
			useDrivePreviewStore.getState().setHasUnsavedEdits(false)
		}
	}, [])

	const containerStyle = {
		backgroundColor:
			previewType === "text" ? bgBackground.backgroundColor : backgroundColors["normal"][theme === "dark" ? "dark" : "light"]
	}

	return (
		<View
			className="flex-1"
			style={containerStyle}
		>
			{hasEdits && item.type === "drive" && (
				<View
					className="absolute left-0 right-0 bg-transparent z-1000 flex-row items-center justify-end pl-4"
					style={{
						top: Platform.select({
							ios: headerHeight ? headerHeight + insets.top : 0,
							default: headerHeight ? headerHeight : 0
						}),
						paddingRight: 16 + insets.right
					}}
				>
					<PressableScale
						className="size-11 items-center justify-center"
						onPress={save}
						hitSlop={10}
						enabled={isOnline}
						rippleColor="transparent"
					>
						<CrossGlassContainerView className="size-11 flex-row items-center justify-center">
							<Ionicons
								name="save-outline"
								size={20}
								color={textPrimary.color}
							/>
						</CrossGlassContainerView>
					</PressableScale>
				</View>
			)}
			<TextEditor
				// A new document always gets a new WebView, so the previous file's document is not a cost
				// this one pays.
				key={galleryItemKey(item)}
				onDocumentEditedChange={setHasEdits}
				onDocumentStatus={setStatus}
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
						<>
							<Ionicons
								name={status === "notText" ? "document-outline" : "warning-outline"}
								size={48}
								color="#9ca3af"
							/>
							<Text className="mt-4 text-center text-sm leading-5 text-muted-foreground">
								{status === "notText" ? t("preview_not_text") : t("preview_load_failed")}
							</Text>
						</>
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

	const previewType = getPreviewType(item.type === "drive" ? (item.data.data.decryptedMeta?.name ?? "") : item.data.name)

	const query = useFileUriQuery(
		item.type === "external"
			? {
					type: "external",
					data: {
						url: item.data.url,
						name: item.data.name
					}
				}
			: {
					type: "drive",
					data: {
						uuid: item.data.data.uuid,
						// By-value so a cross-directory search hit resolves its bytes.
						item: item.data
					}
				}
	)

	// No magic: text has no signature. Content that turns out not to be text is caught after decoding,
	// by the editor's binary-content gate.
	const source = useRangeSource(query.status === "success" ? query.data.uri : null, {
		maxBytes: MAX_TEXT_BYTES
	})

	const containerStyle = {
		backgroundColor:
			previewType === "text" ? bgBackground.backgroundColor : backgroundColors["normal"][theme === "dark" ? "dark" : "light"]
	}

	if (query.status === "pending" && query.fetchStatus === "fetching") {
		return (
			<View
				className="flex-1 items-center justify-center"
				style={containerStyle}
			>
				<ActivityIndicator
					size="small"
					color="white"
				/>
			</View>
		)
	}

	if (query.status !== "success" && query.fetchStatus === "paused") {
		return (
			<View
				className="flex-1 items-center justify-center px-8"
				style={containerStyle}
			>
				<Ionicons
					name="cloud-offline-outline"
					size={48}
					color="#9ca3af"
				/>
				<Text className="mt-4 text-center text-sm leading-5 text-muted-foreground">{t("unavailable_offline")}</Text>
			</View>
		)
	}

	if (query.status === "error") {
		return (
			<View
				className="flex-1 items-center justify-center px-8"
				style={containerStyle}
			>
				<Ionicons
					name="warning-outline"
					size={48}
					color="#9ca3af"
				/>
				<Text className="mt-4 text-center text-sm leading-5 text-muted-foreground">{t("preview_load_failed")}</Text>
				<PressableScale
					className="mt-4"
					onPress={() => query.refetch()}
					hitSlop={10}
				>
					<Text className="text-sm leading-5 text-primary">{t("retry")}</Text>
				</PressableScale>
			</View>
		)
	}

	if (source.status === "refused") {
		return (
			<View
				className="flex-1 items-center justify-center px-8"
				style={containerStyle}
			>
				<Ionicons
					name={source.reason === "tooLarge" ? "document-outline" : "warning-outline"}
					size={48}
					color="#9ca3af"
				/>
				<Text className="mt-4 text-center text-sm leading-5 text-muted-foreground">
					{source.reason === "tooLarge" ? t("text_file_too_large") : t("preview_load_failed")}
				</Text>
			</View>
		)
	}

	if (source.status === "ready") {
		return (
			<PreviewTextInner
				previewType={previewType === "code" ? "code" : "text"}
				source={source}
				item={item}
			/>
		)
	}

	return (
		<View
			className="flex-1 items-center justify-center"
			style={containerStyle}
		>
			<ActivityIndicator
				size="small"
				color="white"
			/>
		</View>
	)
}

export default PreviewText
