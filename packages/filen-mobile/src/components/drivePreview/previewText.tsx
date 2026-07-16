import { useEffect, useRef } from "react"
import View, { CrossGlassContainerView } from "@/components/ui/view"
import Text from "@/components/ui/text"
import {
	unwrapFileMeta,
	unwrappedFileIntoDriveItem,
	getRealDriveItemParent,
	unwrapParentUuid,
	unwrapDirMeta,
	unwrappedDirIntoDriveItem
} from "@/lib/sdkUnwrap"
import { getPreviewType, isProbablyBinaryText } from "@/lib/previewType"
import cache from "@/lib/cache"
import auth from "@/lib/auth"
import events from "@/lib/events"
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
import { AnyDirWithContext, AnyDirWithContext_Tags } from "@filen/sdk-rs"
import { type GalleryItemTagged, galleryItemKey } from "@/components/drivePreview/gallery"
import type { DriveItemFileExtracted } from "@/types"
import useIsOnline from "@/hooks/useIsOnline"
import logger from "@/lib/logger"

const PreviewTextInner = ({ previewType, text, item }: { previewType: "text" | "code"; text: string; item: GalleryItemTagged }) => {
	const { t } = useTranslation()
	const bgBackground = useResolveClassNames("bg-background")
	const { theme } = useUniwind()
	const headerHeight = useDrivePreviewStore(useShallow(state => state.headerHeight))
	const drivePath = useDrivePreviewStore(useShallow(state => state.drivePath))
	const insets = useSafeAreaInsets()
	const [editedText, setEditedText] = useRecyclingState<string | null>(null, [galleryItemKey(item)])
	const textPrimary = useResolveClassNames("text-primary")
	const [itemEdited, setItemEdited] = useRecyclingState<DriveItemFileExtracted | null>(null, [galleryItemKey(item)])
	const isOnline = useIsOnline()
	// Parent directory resolved by a background warm (below) for a cross-directory search
	// hit whose parent isn't in the cache. Resets per item (useRecyclingState key). Preferred
	// over the cache read so `readOnly` recomputes the moment the warm lands (the React
	// Compiler memoizes `parent`, and getRealDriveItemParent reads a non-reactive Map).
	const [warmedParent, setWarmedParent] = useRecyclingState<AnyDirWithContext | null>(null, [galleryItemKey(item)])

	const parent =
		warmedParent ??
		(item.type === "drive" && drivePath
			? getRealDriveItemParent({
					item: item.data,
					drivePath: drivePath
				})
			: null)

	// Warm the parent-directory cache for a deep search-result file: getRealDriveItemParent
	// (and thus editability) needs the parent dir in cache. A file opened from a directory
	// the user never browsed misses, leaving the editor read-only; resolve it by uuid.
	useEffect(() => {
		// Only the plain-drive `file` case (the cache-search scenario) — shared files resolve
		// their parent from a different cache, and only `file` carries a `parent` uuid.
		if (item.type !== "drive" || item.data.type !== "file") {
			return
		}

		const parentUuid = unwrapParentUuid(item.data.data.parent)

		// Root parent resolves without the cache; an already-cached parent needs no warm.
		if (
			!parentUuid ||
			(cache.rootUuid && parentUuid === cache.rootUuid) ||
			cache.directoryUuidToAnyNormalDir.get(parentUuid)
		) {
			return
		}

		const controller = new AbortController()

		void (async () => {
			try {
				const { authedSdkClient } = await auth.getSdkClients()
				const dir = await authedSdkClient.getDirOptional(parentUuid, { signal: controller.signal })

				if (controller.signal.aborted || !dir) {
					return
				}

				const dirItem = unwrappedDirIntoDriveItem(unwrapDirMeta(dir))

				if (dirItem.type !== "directory") {
					return
				}

				cache.cacheNewNormalDir(dir, dirItem)

				const normalDir = cache.directoryUuidToAnyNormalDir.get(parentUuid)

				if (normalDir && !controller.signal.aborted) {
					setWarmedParent(new AnyDirWithContext.Normal(normalDir))
				}
			} catch (e) {
				logger.warn("drivePreview", "Failed to warm parent directory for text preview", { error: e })
			}
		})()

		return () => {
			controller.abort()
		}
	}, [item, setWarmedParent])

	const itemToUse =
		item.type === "drive"
			? itemEdited &&
				itemEdited.data.decryptedMeta?.name.toLowerCase().trim() === item.data.data.decryptedMeta?.name.toLowerCase().trim()
				? itemEdited
				: item.data
			: null

	const readOnly =
		!itemToUse || item.type !== "drive"
			? true
			: itemToUse.type !== "file" || !itemToUse.data.decryptedMeta || !parent || parent === "sharedInRoot"

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
					// The upload rotates the uuid (new content). uploadCore already cached the new
					// item; drop the stale old-uuid entry and tell the list/preview/search the
					// identity rotated so they re-key (Effect D replaces by previousUuid + clears
					// any tombstone). itemToUse is the file we just overwrote (non-null on this path
					// — readOnly would have been true otherwise).
					const oldUuid = itemToUse?.data.uuid

					setItemEdited(newDriveItem)

					useDrivePreviewStore.getState().setCurrentItem({
						type: "drive",
						data: newDriveItem
					})

					if (oldUuid) {
						if (oldUuid !== newDriveItem.data.uuid) {
							cache.forgetItem(oldUuid)
						}

						events.emit("driveItemUpdated", {
							previousUuid: oldUuid,
							item: newDriveItem
						})
					}
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
				type={previewType === "code" ? "code" : "text"}
				fileName={item.type === "drive" ? item.data.data.decryptedMeta?.name : item.data.name}
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
