import View, { CrossGlassContainerView } from "@/components/ui/view"
import { getPreviewType, unwrapFileMeta, unwrappedFileIntoDriveItem, getRealDriveItemParent } from "@/lib/utils"
import TextEditor, { backgroundColors } from "@/components/textEditor"
import { useShallow } from "zustand/shallow"
import useDrivePreviewStore from "@/stores/useDrivePreview.store"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { useResolveClassNames, useUniwind } from "uniwind"
import { ActivityIndicator } from "react-native"
import { useSimpleQuery } from "@/hooks/useSimpleQuery"
import fileCache from "@/lib/fileCache"
import type { DriveItemFileExtracted } from "@/types"
import { memo } from "react"
import { PressableScale } from "@/components/ui/pressables"
import Ionicons from "@expo/vector-icons/Ionicons"
import transfers from "@/lib/transfers"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import alerts from "@/lib/alerts"
import * as FileSystem from "expo-file-system"
import { randomUUID } from "expo-crypto"
import offline from "@/lib/offline"
import { useRecyclingState } from "@shopify/flash-list"
import type { DrivePath } from "@/hooks/useDrivePath"
import { AnyDirWithContext_Tags } from "@filen/sdk-rs"

const PreviewTextInner = memo(
	({
		previewType,
		text,
		item,
		drivePath
	}: {
		previewType: "text" | "code"
		text: string
		item: DriveItemFileExtracted
		drivePath: DrivePath
	}) => {
		const bgBackground = useResolveClassNames("bg-background")
		const { theme } = useUniwind()
		const headerHeight = useDrivePreviewStore(useShallow(state => state.headerHeight))
		const insets = useSafeAreaInsets()
		const [editedText, setEditedText] = useRecyclingState<string | null>(null, [item.data.uuid])
		const textPrimary = useResolveClassNames("text-primary")
		const currentItemEdited = useDrivePreviewStore(useShallow(state => state.currentItemEdited))

		const parent = getRealDriveItemParent({
			item,
			drivePath
		})

		const itemToUse =
			currentItemEdited &&
			currentItemEdited.data.decryptedMeta?.name.toLowerCase().trim() === item.data.decryptedMeta?.name.toLowerCase().trim()
				? currentItemEdited
				: item

		const readOnly = itemToUse.type !== "file" || !itemToUse.data.decryptedMeta || !parent || parent === "sharedInRoot"

		const save = async () => {
			if (editedText === null || readOnly) {
				return
			}

			const result = await runWithLoading(async defer => {
				if (!itemToUse.data.decryptedMeta) {
					throw new Error("Missing decryptedMeta")
				}

				if (!parent || parent.tag !== AnyDirWithContext_Tags.Normal) {
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
				const newFile = result.data.files[0]

				if (newFile) {
					const newDriveItem = unwrappedFileIntoDriveItem(unwrapFileMeta(newFile))

					if (newDriveItem.type === "file") {
						useDrivePreviewStore.getState().setCurrentItemEdited(newDriveItem)
						useDrivePreviewStore.getState().setCurrentItem(newDriveItem)
					}
				}
			}

			setEditedText(null)
		}

		return (
			<View
				className="flex-1"
				style={{
					backgroundColor:
						previewType === "text"
							? bgBackground.backgroundColor
							: backgroundColors["normal"][theme === "dark" ? "dark" : "light"]
				}}
			>
				{editedText !== null && (
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
	}
)

const PreviewText = memo(({ item, drivePath }: { item: DriveItemFileExtracted; drivePath: DrivePath }) => {
	const bgBackground = useResolveClassNames("bg-background")
	const { theme } = useUniwind()
	const previewType = getPreviewType(item.data.decryptedMeta?.name ?? "")

	const query = useSimpleQuery(async signal => {
		const isStoredOffline = await offline.isItemStored(item)

		if (isStoredOffline) {
			const file = await offline.getLocalFile(item)

			if (file) {
				return await file.text()
			}
		}

		const file = await fileCache.get({
			item,
			signal
		})

		return await file.text()
	})

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
			drivePath={drivePath}
		/>
	)
})

export default PreviewText
