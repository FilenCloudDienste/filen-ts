import { Fragment, useRef } from "react"
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
import drive from "@/features/drive/drive"
import cache from "@/lib/cache"
import { AnyNormalDir } from "@filen/sdk-rs"
import { useSdkClients } from "@/lib/auth"
import { unwrapParentUuid } from "@/lib/sdkUnwrap"
import useDriveSelectStore from "@/features/drive/store/useDriveSelect.store"
import { useShallow } from "zustand/shallow"
import events from "@/lib/events"
import { useNavigation } from "expo-router"
import { useTranslation } from "react-i18next"
import useIsOnline from "@/hooks/useIsOnline"

const DriveSelectToolbar = () => {
	const textForeground = useResolveClassNames("text-foreground")
	const insets = useSafeAreaInsets()
	const drivePath = useDrivePath()
	const { authedSdkClient } = useSdkClients()
	const selectedItems = useDriveSelectStore(useShallow(state => state.selectedItems))
	const navigation = useNavigation()
	const { t } = useTranslation()
	const isOnline = useIsOnline()
	const isSubmitting = useRef(false)

	const parentDir = (() => {
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
	})()

	const isSameParentAsSelectedItems = (() => {
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
	})()

	const canSelect = (() => {
		if (!drivePath.selectOptions) {
			return false
		}

		if (drivePath.selectOptions.directories) {
			return selectedItems.length > 0 || parentDir !== null
		}

		return selectedItems.length > 0
	})()

	const createDirectory = async () => {
		if (!parentDir) {
			return
		}

		if (!isOnline) {
			alerts.error(new Error(t("youre_offline")))

			return
		}

		const promptResult = await run(async () => {
			return await prompts.input({
				title: t("create_directory"),
				message: t("enter_directory_name"),
				cancelText: t("cancel"),
				okText: t("create")
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
	}

	const submit = async () => {
		if (!drivePath.selectOptions) {
			return
		}

		if (drivePath.selectOptions.intention === "move" && !isOnline) {
			alerts.error(new Error(t("youre_offline")))

			return
		}

		if (isSubmitting.current) {
			return
		}

		isSubmitting.current = true

		try {
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

					navigation.getParent()?.goBack()

					break
				}

				case "select": {
					if (!canSelect) {
						return
					}

					navigation.getParent()?.goBack()

					if (selectedItems.length === 0) {
						if (!parentDir || !drivePath.selectOptions.directories) {
							return
						}

						events.emit("driveSelect", {
							id: drivePath.selectOptions.id,
							selectedItems: [
								{
									type: "root",
									data: parentDir
								}
							],
							cancelled: false
						})

						return
					}

					events.emit("driveSelect", {
						id: drivePath.selectOptions.id,
						selectedItems: selectedItems.map(item => ({
							type: "driveItem",
							data: item
						})),
						cancelled: false
					})

					break
				}
			}
		} finally {
			isSubmitting.current = false
		}
	}

	return (
		<Fragment>
			{parentDir && (
				<PressableScale
					className="absolute left-4"
					onPress={createDirectory}
					enabled={isOnline}
					style={{
						bottom: insets.bottom
					}}
				>
					<CrossGlassContainerView className={cn("size-12 flex-row items-center justify-center", !isOnline && "opacity-50")}>
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
					enabled={!isSameParentAsSelectedItems && isOnline}
					style={{
						bottom: insets.bottom
					}}
				>
					<CrossGlassContainerView
						className={cn(
							"min-h-12 min-w-12 px-4 flex-row items-center justify-center",
							(isSameParentAsSelectedItems || !isOnline) && "opacity-50"
						)}
					>
						<Text className="font-bold text-blue-500">{t("move_here")}</Text>
					</CrossGlassContainerView>
				</PressableScale>
			)}
			{drivePath.selectOptions?.intention === "select" && (
				<PressableScale
					onPress={submit}
					className="absolute right-4"
					enabled={canSelect}
					style={{
						bottom: insets.bottom
					}}
				>
					<CrossGlassContainerView
						className={cn("min-h-12 min-w-12 px-4 flex-row items-center justify-center", !canSelect && "opacity-50")}
					>
						<Text className="font-bold text-blue-500">
							{selectedItems.length === 0 && parentDir && drivePath.selectOptions.directories
								? t("select_root")
								: t("select_n_items", { count: selectedItems.length })}
						</Text>
					</CrossGlassContainerView>
				</PressableScale>
			)}
		</Fragment>
	)
}

export default DriveSelectToolbar
