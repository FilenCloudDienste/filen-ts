import { Fragment, memo, useCallback, useMemo } from "react"
import { CrossGlassContainerView } from "@/components/ui/view"
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons"
import { useResolveClassNames } from "uniwind"
import Text from "@/components/ui/text"
import { PressableScale } from "@/components/ui/pressables"
import useDrivePath from "@/hooks/useDrivePath"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { run, cn } from "@filen/utils"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import prompts from "@/lib/prompts"
import alerts from "@/lib/alerts"
import drive from "@/lib/drive"
import cache from "@/lib/cache"
import { AnyNormalDir } from "@filen/sdk-rs"
import { useSdkClients } from "@/lib/auth"
import { unwrapParentUuid } from "@/lib/utils"
import useDriveSelectStore from "@/stores/useDriveSelect.store"
import { useShallow } from "zustand/shallow"
import events from "@/lib/events"
import { router } from "expo-router"

// TODO: Fix memoization
const DriveSelectToolbar = memo(() => {
	const textForeground = useResolveClassNames("text-foreground")
	const insets = useSafeAreaInsets()
	const drivePath = useDrivePath()
	const { authedSdkClient } = useSdkClients()
	const selectedItems = useDriveSelectStore(useShallow(state => state.selectedItems))

	const parentDir = useMemo(() => {
		if (!authedSdkClient) {
			return null
		}

		if (!drivePath.uuid || drivePath.uuid === authedSdkClient.root().uuid) {
			return new AnyNormalDir.Root(authedSdkClient.root())
		}

		const parentDir = cache.directoryUuidToAnyNormalDir.get(drivePath.uuid)

		if (!parentDir) {
			return null
		}

		return parentDir
	}, [drivePath.uuid, authedSdkClient])

	const isSameParentAsSelectedItems = useMemo(() => {
		if (!parentDir || !drivePath.selectOptions) {
			return false
		}

		return drivePath.selectOptions.items.some(item => {
			if (item.type !== "file" && item.type !== "directory") {
				return false
			}

			const itemParentUuid = unwrapParentUuid(item.data.parent)

			return itemParentUuid === parentDir.inner[0].uuid
		})
	}, [parentDir, drivePath.selectOptions])

	const createDirectory = useCallback(async () => {
		if (!parentDir) {
			return
		}

		const promptResult = await run(async () => {
			return await prompts.input({
				title: "tbd_create_directory",
				message: "tbd_enter_directory_name",
				cancelText: "tbd_cancel",
				okText: "tbd_create"
			})
		})

		if (!promptResult.success) {
			console.error(promptResult.error)
			alerts.error(promptResult.error)

			return
		}

		if (promptResult.data.cancelled || promptResult.data.type !== "string") {
			return
		}

		const newName = promptResult.data.value.trim()

		if (newName.length === 0) {
			return
		}

		const result = await runWithLoading(async () => {
			await drive.createDirectory({
				parent: parentDir,
				name: newName
			})
		})

		if (!result.success) {
			console.error(result.error)
			alerts.error(result.error)

			return
		}
	}, [parentDir])

	const submit = useCallback(async () => {
		if (!drivePath.selectOptions) {
			return
		}

		switch (drivePath.selectOptions.intention) {
			case "move": {
				if (!parentDir || drivePath.selectOptions.items.length === 0 || isSameParentAsSelectedItems) {
					return
				}

				const items = drivePath.selectOptions.items
				const result = await runWithLoading(async () => {
					await Promise.all(
						items.map(async item => {
							await drive.move({
								newParent: parentDir,
								item
							})
						})
					)
				})

				if (!result.success) {
					console.error(result.error)
					alerts.error(result.error)

					return
				}

				break
			}

			case "select": {
				router.dismissAll()

				events.emit("driveSelect", {
					id: drivePath.selectOptions.id,
					selectedItems,
					cancelled: false
				})

				break
			}
		}
	}, [drivePath.selectOptions, parentDir, isSameParentAsSelectedItems, selectedItems])

	return (
		<Fragment>
			{parentDir && (
				<PressableScale
					className="absolute left-4"
					onPress={createDirectory}
					style={{
						bottom: insets.bottom
					}}
				>
					<CrossGlassContainerView className="size-12 flex-row items-center justify-center">
						<MaterialCommunityIcons
							name="folder-plus-outline"
							size={24}
							color={textForeground.color}
						/>
					</CrossGlassContainerView>
				</PressableScale>
			)}
			{drivePath.selectOptions?.intention === "move" && parentDir && drivePath.selectOptions.items.length > 0 && (
				<PressableScale
					onPress={submit}
					className="absolute right-4"
					style={{
						bottom: insets.bottom
					}}
				>
					<CrossGlassContainerView
						className={cn(
							"min-h-12 min-w-12 px-4 flex-row items-center justify-center",
							isSameParentAsSelectedItems && "opacity-50"
						)}
					>
						<Text className="font-bold text-blue-500">tbd_move_here</Text>
					</CrossGlassContainerView>
				</PressableScale>
			)}
			{drivePath.selectOptions?.intention === "select" && (
				<PressableScale
					onPress={submit}
					className="absolute right-4"
					style={{
						bottom: insets.bottom
					}}
				>
					<CrossGlassContainerView
						className={cn(
							"min-h-12 min-w-12 px-4 flex-row items-center justify-center",
							selectedItems.length === 0 && "opacity-50"
						)}
					>
						<Text className="font-bold text-blue-500">tbd_select_items {selectedItems.length}</Text>
					</CrossGlassContainerView>
				</PressableScale>
			)}
		</Fragment>
	)
})

export default DriveSelectToolbar
