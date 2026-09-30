import { Fragment, useRef } from "react"
import { CrossGlassContainerView } from "@/components/ui/view"
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons"
import { useResolveClassNames } from "uniwind"
import FloatingActionPill from "@/components/ui/floatingActionPill"
import { PressableScale } from "@/components/ui/pressables"
import useDrivePath from "@/hooks/useDrivePath"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { cn } from "@filen/shared"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import { promptAndCreateDirectory } from "@/features/drive/components/driveCreateMenu"
import alerts from "@/lib/alerts"
import drive from "@/features/drive/drive"
import cache from "@/lib/cache"
import { AnyNormalDir } from "@filen/sdk-rs"
import { useSdkClients } from "@/lib/auth"
import { normalParentUuidOf } from "@/lib/sdkUnwrap"
import useDriveSelectStore, { selectDriveSelectSelection } from "@/features/drive/store/useDriveSelect.store"
import { everyItemAlreadyIn } from "@/features/drive/driveSelectors"
import { useShallow } from "zustand/shallow"
import events from "@/lib/events"
import useDismissStack from "@/hooks/useDismissStack"
import { useTranslation } from "react-i18next"
import useIsOnline from "@/hooks/useIsOnline"
import logger from "@/lib/logger"

const DriveSelectToolbar = () => {
	const textForeground = useResolveClassNames("text-foreground")
	const insets = useSafeAreaInsets()
	const drivePath = useDrivePath()
	const { authedSdkClient } = useSdkClients()
	const selectSessionId = drivePath.selectOptions?.id
	const selectedItems = useDriveSelectStore(useShallow(state => selectDriveSelectSelection(state, selectSessionId)))
	const dismiss = useDismissStack()
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

	const isSameParentAsSelectedItems =
		parentDir !== null &&
		drivePath.selectOptions !== undefined &&
		everyItemAlreadyIn(drivePath.selectOptions.items, parentDir.inner[0].uuid, normalParentUuidOf)

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

		await promptAndCreateDirectory({ parent: parentDir, t })
	}

	const submit = async () => {
		if (!drivePath.selectOptions) {
			return
		}

		if ((drivePath.selectOptions.intention === "move" || drivePath.selectOptions.intention === "copy") && !isOnline) {
			alerts.error(new Error(t("youre_offline")))

			return
		}

		switch (drivePath.selectOptions.intention) {
			case "move": {
				if (!parentDir || drivePath.selectOptions.items.length === 0 || isSameParentAsSelectedItems || isSubmitting.current) {
					return
				}

				isSubmitting.current = true

				const items = drivePath.selectOptions.items
				// runWithLoading returns a Result and never throws, so the guard always resets.
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

				isSubmitting.current = false

				if (!result.success) {
					logger.error("driveSelect", "Move operation failed", { error: result.error })
					alerts.error(result.error)

					return
				}

				dismiss()

				break
			}

			// Copying into the items' own directory is allowed (the copies get "name (1)"). The caller
			// starts the job; the picker only hands back where. A public link's sources aren't drive
			// items, so a copy session may carry none.
			case "copy": {
				if (!parentDir) {
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

				dismiss()

				break
			}

			case "select": {
				if (!canSelect) {
					return
				}

				dismiss()

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
	}

	return (
		<Fragment>
			{parentDir && (
				<PressableScale
					className="absolute left-4"
					testID="drive-select-create-directory"
					accessibilityLabel={t("create_directory")}
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
				<FloatingActionPill
					testID="drive-select-move-here"
					label={t("move_here")}
					enabled={!isSameParentAsSelectedItems && isOnline}
					onPress={submit}
				/>
			)}
			{drivePath.selectOptions?.intention === "copy" && parentDir && (
				<FloatingActionPill
					testID="drive-select-copy-here"
					label={t("copy_here")}
					enabled={isOnline}
					onPress={submit}
				/>
			)}
			{drivePath.selectOptions?.intention === "select" && (
				<FloatingActionPill
					label={
						selectedItems.length === 0 && parentDir && drivePath.selectOptions.directories
							? t("select_root")
							: t("select_n_items", { count: selectedItems.length })
					}
					enabled={canSelect}
					onPress={submit}
				/>
			)}
		</Fragment>
	)
}

export default DriveSelectToolbar
