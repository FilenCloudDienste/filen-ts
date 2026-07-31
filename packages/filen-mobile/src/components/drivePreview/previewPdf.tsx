import { useEffect, useRef } from "react"
import { useTranslation } from "react-i18next"
import { ActivityIndicator } from "react-native"
import { useShallow } from "zustand/shallow"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import Ionicons from "@expo/vector-icons/Ionicons"
import View, { CrossGlassContainerView } from "@/components/ui/view"
import Text from "@/components/ui/text"
import { PressableScale } from "@/components/ui/pressables"
import PdfPreview from "@/components/pdfPreview"
import useRangeSource from "@/hooks/useRangeSource"
import { MAX_PDF_BYTES } from "@/components/pdfPreview/constants"
import { PDF_MAGIC } from "@/lib/rangeTransfer"
import useFileUriQuery from "@/queries/useFileUri.query"
import useDrivePreviewStore from "@/stores/useDrivePreview.store"
import { galleryItemKey, type GalleryItemTagged } from "@/components/drivePreview/gallery"
import useEditableTarget from "@/components/drivePreview/useEditableTarget"
import { unwrapFileMeta, unwrappedFileIntoDriveItem } from "@/lib/sdkUnwrap"
import { AnyDirWithContext_Tags } from "@filen/sdk-rs"
import { useRecyclingState } from "@shopify/flash-list"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import transfers from "@/features/transfers/transfers"
import useIsOnline from "@/hooks/useIsOnline"
import { useResolveClassNames } from "uniwind"
import alerts from "@/lib/alerts"
import logger from "@/lib/logger"
import type { File } from "expo-file-system"

const PreviewPdf = ({ item }: { item: GalleryItemTagged }) => {
	const { t } = useTranslation()
	const headerHeight = useDrivePreviewStore(useShallow(state => state.headerHeight))
	const insets = useSafeAreaInsets()
	const isOnline = useIsOnline()
	const textPrimary = useResolveClassNames("text-primary")
	const { itemToUse, parent, readOnly, applySaved } = useEditableTarget(item)
	const [hasEdits, setHasEdits] = useRecyclingState<boolean>(false, [galleryItemKey(item)])
	const saveHandleRef = useRef<(() => Promise<File | null>) | null>(null)

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

	const source = useRangeSource(query.status === "success" ? query.data.uri : null, {
		maxBytes: MAX_PDF_BYTES,
		magic: PDF_MAGIC
	})

	const save = async (): Promise<boolean> => {
		if (!hasEdits || readOnly || !isOnline) {
			return false
		}

		const result = await runWithLoading(async defer => {
			if (!itemToUse?.data.decryptedMeta) {
				throw new Error("Missing decryptedMeta")
			}

			if (!parent || parent === "sharedInRoot" || parent.tag !== AnyDirWithContext_Tags.Normal) {
				throw new Error("Missing parent directory")
			}

			// Serialised by the viewer into a temp file — the bytes never cross the bridge whole.
			const savedFile = await saveHandleRef.current?.()

			if (!savedFile) {
				throw new Error("The document could not be saved")
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
			logger.error("drivePreview", "PDF save failed", {
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

	// save() is re-created each render; publish ONE stable wrapper so the guard can save-then-leave,
	// and clear it on unmount so a later preview cannot inherit this item's dirty state.
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

	if (query.status === "pending" && query.fetchStatus === "fetching") {
		return (
			<View className="bg-background flex-1 items-center justify-center">
				<ActivityIndicator
					size="small"
					color="white"
				/>
			</View>
		)
	}

	if (query.status !== "success" && query.fetchStatus === "paused") {
		return (
			<View className="bg-background flex-1 items-center justify-center px-8">
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
			<View className="bg-background flex-1 items-center justify-center px-8">
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

	// Refusals are typed rather than collapsed into the generic error state: "larger than the viewer
	// will open" is advice and "this is not a PDF" is a different fact, and a lone retry button answers
	// neither of them.
	if (source.status === "refused") {
		return (
			<View className="bg-background flex-1 items-center justify-center px-8">
				<Ionicons
					name={source.reason === "tooLarge" ? "document-outline" : "warning-outline"}
					size={48}
					color="#9ca3af"
				/>
				<Text className="mt-4 text-center text-sm leading-5 text-muted-foreground">
					{source.reason === "tooLarge" ? t("pdf_too_large") : source.reason === "wrongFormat" ? t("invalid_pdf") : t("unable_to_load_pdf")}
				</Text>
			</View>
		)
	}

	if (source.status === "ready") {
		return (
			<View className="bg-background flex-1">
				{hasEdits && !readOnly && (
					<View
						className="absolute left-0 right-0 bg-transparent z-1000 flex-row items-center justify-end pl-4"
						style={{
							top: headerHeight ? headerHeight + insets.top : 0,
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
					paddingLeft={insets.left}
					paddingRight={insets.right}
				/>
			</View>
		)
	}

	return (
		<View className="bg-background flex-1 items-center justify-center">
			<ActivityIndicator
				size="small"
				color="white"
			/>
		</View>
	)
}

export default PreviewPdf
