import View, { CrossGlassContainerView } from "@/components/ui/view"
import { getPreviewType } from "@/lib/utils"
import TextEditor, { backgroundColors } from "@/components/textEditor"
import { useShallow } from "zustand/shallow"
import useDrivePreviewStore from "@/stores/useDrivePreview.store"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { useResolveClassNames, useUniwind } from "uniwind"
import { ActivityIndicator } from "react-native"
import { useSimpleQuery } from "@/hooks/useSimpleQuery"
import fileCache from "@/lib/fileCache"
import type { DriveItemFileExtracted } from "@/types"
import { useState, memo, useMemo, useCallback } from "react"
import { PressableScale } from "@/components/ui/pressables"
import Ionicons from "@expo/vector-icons/Ionicons"
import transfers from "@/lib/transfers"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import alerts from "@/lib/alerts"
import * as FileSystem from "expo-file-system"
import { randomUUID } from "expo-crypto"
import { type AnyDirWithContext, AnyDirWithContext_Tags } from "@filen/sdk-rs"
import offline from "@/lib/offline"

const PreviewTextInner = memo(
	({
		previewType,
		text,
		item,
		parent
	}: {
		previewType: "text" | "code"
		text: string
		item: DriveItemFileExtracted
		parent?: AnyDirWithContext
	}) => {
		const bgBackground = useResolveClassNames("bg-background")
		const { theme } = useUniwind()
		const headerHeight = useDrivePreviewStore(useShallow(state => state.headerHeight))
		const insets = useSafeAreaInsets()
		const [editedText, setEditedText] = useState<string | null>(null)
		const textPrimary = useResolveClassNames("text-primary")

		const readOnly = useMemo(() => {
			// TODO: fix isOwner check
			return item.type !== "file" || !item.data.decryptedMeta || !parent
		}, [item, parent])

		const save = useCallback(async () => {
			if (editedText === null || readOnly) {
				return
			}

			const result = await runWithLoading(async defer => {
				if (!item.data.decryptedMeta) {
					throw new Error("Missing decryptedMeta")
				}

				if (!parent) {
					throw new Error("Missing parent directory")
				}

				if (parent.tag !== AnyDirWithContext_Tags.Normal) {
					throw new Error("Parent is not a normal directory")
				}

				const tmpFile = new FileSystem.File(
					FileSystem.Paths.join(FileSystem.Paths.cache.uri, randomUUID(), item.data.decryptedMeta.name)
				)

				defer(() => {
					if (tmpFile.parentDirectory.exists) {
						tmpFile.parentDirectory.delete()
					}
				})

				if (!tmpFile.parentDirectory.exists) {
					tmpFile.parentDirectory.create({
						idempotent: true,
						intermediates: true
					})
				}

				tmpFile.write(new TextEncoder().encode(editedText))

				return await transfers.upload({
					id: tmpFile.uri,
					localFileOrDir: tmpFile,
					parent: parent.inner[0]
				})
			})

			if (!result.success) {
				console.error(result.error)
				alerts.error(result.error)

				return
			}

			setEditedText(null)
		}, [editedText, readOnly, item, parent])

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

const PreviewText = memo(({ item, parent }: { item: DriveItemFileExtracted; parent?: AnyDirWithContext }) => {
	const bgBackground = useResolveClassNames("bg-background")
	const { theme } = useUniwind()

	const previewType = useMemo(() => {
		return getPreviewType(item.data.decryptedMeta?.name ?? "")
	}, [item.data.decryptedMeta])

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
			parent={parent}
		/>
	)
})

export default PreviewText
