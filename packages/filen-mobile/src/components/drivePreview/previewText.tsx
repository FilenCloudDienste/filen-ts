import { useEffect, useRef } from "react"
import View, { CrossGlassContainerView } from "@/components/ui/view"
import Text from "@/components/ui/text"
import { unwrapFileMeta, unwrappedFileIntoDriveItem } from "@/lib/sdkUnwrap"
import { getPreviewType, isProbablyBinaryText } from "@/lib/previewType"
import TextEditor, { backgroundColors } from "@/components/textEditor"
import { useShallow } from "zustand/shallow"
import useDrivePreviewStore from "@/stores/useDrivePreview.store"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { useResolveClassNames, useUniwind } from "uniwind"
import { ActivityIndicator } from "react-native"
import useFileTextQuery from "@/queries/useFileText.query"
import { useTranslation } from "react-i18next"
import { PressableScale } from "@/components/ui/pressables"
import Ionicons from "@expo/vector-icons/Ionicons"
import transfers from "@/features/transfers/transfers"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import alerts from "@/lib/alerts"
import { newTmpFile } from "@/lib/tmp"
import { useRecyclingState } from "@shopify/flash-list"
import { AnyDirWithContext_Tags } from "@filen/sdk-rs"
import { type GalleryItemTagged, galleryItemKey } from "@/components/drivePreview/gallery"
import useEditableTarget from "@/components/drivePreview/useEditableTarget"
import useIsOnline from "@/hooks/useIsOnline"
import logger from "@/lib/logger"

const PreviewTextInner = ({ previewType, text, item }: { previewType: "text" | "code"; text: string; item: GalleryItemTagged }) => {
	const { t } = useTranslation()
	const bgBackground = useResolveClassNames("bg-background")
	const { theme } = useUniwind()
	const headerHeight = useDrivePreviewStore(useShallow(state => state.headerHeight))
	const insets = useSafeAreaInsets()
	const [editedText, setEditedText] = useRecyclingState<string | null>(null, [galleryItemKey(item)])
	const textPrimary = useResolveClassNames("text-primary")
	const isOnline = useIsOnline()
	const { itemToUse, parent, readOnly, applySaved } = useEditableTarget(item)

	const fileName = item.type === "drive" ? item.data.data.decryptedMeta?.name : item.data.name

	// Rendered-markdown parity with notes (Play review request): markdown files get the
	// markdown editor + the floating preview toggle instead of the plain code editor. One
	// shared toggle id for ALL drive markdown files — per-file ids would grow the persisted
	// toggle record with every file ever previewed, and "show rendered markdown" is a mode
	// preference, not a per-file one.
	const isMarkdownFile = /\.(md|markdown)$/i.test(fileName ?? "")

	const save = async (): Promise<boolean> => {
		if (editedText === null || readOnly || !isOnline) {
			return false
		}

		const result = await runWithLoading(async defer => {
			if (!itemToUse) {
				throw new Error("Missing item to use for saving")
			}

			if (!itemToUse.data.decryptedMeta) {
				throw new Error("Missing decryptedMeta")
			}

			if (!parent || parent === "sharedInRoot" || parent.tag !== AnyDirWithContext_Tags.Normal) {
				throw new Error("Missing parent directory")
			}

			const tmpFile = newTmpFile()

			defer(() => {
				if (tmpFile.exists) {
					tmpFile.delete()
				}
			})

			if (tmpFile.exists) {
				tmpFile.delete()
			}

			tmpFile.write(new TextEncoder().encode(editedText))

			return await transfers.upload({
				localFileOrDir: tmpFile,
				parent: parent.inner[0],
				name: itemToUse.data.decryptedMeta.name,
				modified: Date.now(),
				created: itemToUse.data.decryptedMeta.created != null ? Number(itemToUse.data.decryptedMeta.created) : undefined,
				mime: itemToUse.data.decryptedMeta.mime
			})
		})

		if (!result.success) {
			logger.error("drivePreview", "Text file save failed", { error: result.error })
			alerts.error(result.error)

			return false
		}

		if (result.data) {
			setEditedText(null)

			const newFile = result.data.files[0]

			if (newFile) {
				const newDriveItem = unwrappedFileIntoDriveItem(unwrapFileMeta(newFile))

				if (newDriveItem.type === "file") {
					applySaved(newDriveItem)
				}
			}

			return true
		}

		return false
	}

	// Publish the dirty flag so the route-level unsaved-changes guard can prompt on navigate-away.
	useEffect(() => {
		useDrivePreviewStore.getState().setHasUnsavedEdits(editedText !== null && !readOnly)
	}, [editedText, readOnly])

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

	return (
		<View
			className="flex-1"
			style={{
				backgroundColor:
					previewType === "text" ? bgBackground.backgroundColor : backgroundColors["normal"][theme === "dark" ? "dark" : "light"]
			}}
		>
			{editedText !== null && item.type === "drive" && (
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
			<TextEditor
				initialValue={text}
				onValueChange={setEditedText}
				readOnly={readOnly}
				placeholder={t("placeholder")}
				type={isMarkdownFile ? "markdown" : previewType === "code" ? "code" : "text"}
				id={isMarkdownFile ? "drivePreview" : undefined}
				fileName={fileName}
				paddingTop={headerHeight ? headerHeight + 8 : undefined}
				paddingBottom={insets.bottom}
			/>
		</View>
	)
}

const PreviewText = ({ item }: { item: GalleryItemTagged }) => {
	const { t } = useTranslation()
	const bgBackground = useResolveClassNames("bg-background")
	const { theme } = useUniwind()

	const previewType = getPreviewType(item.type === "drive" ? (item.data.data.decryptedMeta?.name ?? "") : item.data.name)

	const query = useFileTextQuery(
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

	if (query.status === "success") {
		// Binary bytes behind a text extension (e.g. macOS "._*" AppleDouble sidecars)
		// decode to NUL/replacement-character soup — don't hand that to the editor
		// (it renders as deceptively empty and saving it would corrupt the file).
		if (isProbablyBinaryText(query.data)) {
			return (
				<View
					className="flex-1 items-center justify-center px-8"
					style={containerStyle}
				>
					<Ionicons
						name="document-outline"
						size={48}
						color="#9ca3af"
					/>
					<Text className="mt-4 text-center text-sm leading-5 text-muted-foreground">{t("preview_not_text")}</Text>
				</View>
			)
		}

		return (
			<PreviewTextInner
				previewType={previewType === "code" ? "code" : "text"}
				text={query.data}
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
