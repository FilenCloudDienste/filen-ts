import View, { CrossGlassContainerView } from "@/components/ui/view"
import { getPreviewType, unwrapFileMeta, unwrappedFileIntoDriveItem, getRealDriveItemParent } from "@/lib/utils"
import TextEditor, { backgroundColors } from "@/components/textEditor"
import { useShallow } from "zustand/shallow"
import useDrivePreviewStore from "@/stores/useDrivePreview.store"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { useResolveClassNames, useUniwind } from "uniwind"
import { ActivityIndicator } from "react-native"
import useFileTextQuery from "@/queries/useFileText.query"
import { memo } from "react"
import { PressableScale } from "@/components/ui/pressables"
import Ionicons from "@expo/vector-icons/Ionicons"
import transfers from "@/lib/transfers"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import alerts from "@/lib/alerts"
import * as FileSystem from "expo-file-system"
import { randomUUID } from "expo-crypto"
import { useRecyclingState } from "@shopify/flash-list"
import { AnyDirWithContext_Tags } from "@filen/sdk-rs"
import type { GalleryItemTagged } from "@/components/drivePreview/gallery"
import type { DriveItemFileExtracted } from "@/types"

const PreviewTextInner = memo(({ previewType, text, item }: { previewType: "text" | "code"; text: string; item: GalleryItemTagged }) => {
	const bgBackground = useResolveClassNames("bg-background")
	const { theme } = useUniwind()
	const headerHeight = useDrivePreviewStore(useShallow(state => state.headerHeight))
	const drivePath = useDrivePreviewStore(useShallow(state => state.drivePath))
	const insets = useSafeAreaInsets()
	const [editedText, setEditedText] = useRecyclingState<string | null>(null, [
		item.type === "drive" ? item.data.data.uuid : item.data.url
	])
	const textPrimary = useResolveClassNames("text-primary")
	const [itemEdited, setItemEdited] = useRecyclingState<DriveItemFileExtracted | null>(null, [
		item.type === "drive" ? item.data.data.uuid : item.data.url
	])

	const parent =
		item.type === "drive" && drivePath
			? getRealDriveItemParent({
					item: item.data,
					drivePath: drivePath
				})
			: null

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

	const save = async () => {
		if (editedText === null || readOnly) {
			return
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

			const tmpFile = new FileSystem.File(FileSystem.Paths.join(FileSystem.Paths.cache, randomUUID()))

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
				created: itemToUse.data.decryptedMeta.created ? Number(itemToUse.data.decryptedMeta.created) : undefined,
				mime: itemToUse.data.decryptedMeta.mime
			})
		})

		if (!result.success) {
			console.error(result.error)
			alerts.error(result.error)

			return
		}

		if (result.data) {
			setEditedText(null)

			const newFile = result.data.files[0]

			if (newFile) {
				const newDriveItem = unwrappedFileIntoDriveItem(unwrapFileMeta(newFile))

				if (newDriveItem.type === "file") {
					setItemEdited(newDriveItem)

					useDrivePreviewStore.getState().setCurrentItem({
						type: "drive",
						data: newDriveItem
					})
				}
			}
		}
	}

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
					className="absolute left-0 right-0 bg-transparent z-1000 flex-row items-center justify-end px-4"
					style={{
						top: headerHeight ? headerHeight + insets.top : 0
					}}
				>
					<PressableScale
						className="size-11 items-center justify-center"
						onPress={save}
						hitSlop={10}
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
				placeholder="tbd_placeholder"
				type={previewType === "code" ? "code" : "text"}
				disableRichtextToolbar={true}
				paddingTop={headerHeight ? headerHeight + 8 : undefined}
				paddingBottom={insets.bottom}
			/>
		</View>
	)
})

const PreviewText = memo(({ item }: { item: GalleryItemTagged }) => {
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
						uuid: item.data.data.uuid
					}
				}
	)

	if (query.status !== "success") {
		return (
			<View
				className="flex-1 items-center justify-center"
				style={{
					backgroundColor:
						previewType === "text"
							? bgBackground.backgroundColor
							: backgroundColors["normal"][theme === "dark" ? "dark" : "light"]
				}}
			>
				<ActivityIndicator
					size="small"
					color="white"
				/>
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
})

export default PreviewText
