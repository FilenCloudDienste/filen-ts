import { Platform } from "react-native"
import { onlineManager } from "@tanstack/react-query"
import { useLocalSearchParams, useNavigation, useFocusEffect } from "expo-router"
import { deserializeRouteParam } from "@/lib/serializer"
import type { DriveItem } from "@/types"
import SafeAreaView from "@/components/ui/safeAreaView"
import ListEmpty from "@/components/ui/listEmpty"
import Header, { type HeaderItem } from "@/components/ui/header"
import { Fragment, useCallback } from "react"
import { useTranslation } from "react-i18next"
import { useResolveClassNames } from "uniwind"
import { run, formatBytes } from "@filen/utils"
import useDriveItemVersionsQuery from "@/features/drive/queries/useDriveItemVersions.query"
import VirtualList from "@/components/ui/virtualList"
import { simpleDate } from "@/lib/time"
import drive from "@/features/drive/drive"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import alerts from "@/lib/alerts"
import prompts from "@/lib/prompts"
import type { FileVersion } from "@filen/sdk-rs"
import Menu, { type MenuButton } from "@/components/ui/menu"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import DismissStack from "@/components/dismissStack"
import useFileVersionsStore from "@/features/drive/store/useFileVersions.store"
import { useShallow } from "zustand/shallow"
import { runBulk } from "@/lib/bulkOps"
import EllipsisMenuTrigger from "@/components/ui/ellipsisMenuTrigger"
import ListRow from "@/components/ui/listRow"
import useIsOnline from "@/hooks/useIsOnline"

const Version = ({ version, item }: { version: FileVersion; item: DriveItem }) => {
	const { t } = useTranslation()
	const isSelected = useFileVersionsStore(useShallow(state => state.selectedVersions.some(v => v.uuid === version.uuid)))
	const areVersionsSelected = useFileVersionsStore(useShallow(state => state.selectedVersions.length > 0))

	return (
		<ListRow
			separator={true}
			selectable={areVersionsSelected}
			selected={isSelected}
			onPress={() => {
				if (areVersionsSelected) {
					useFileVersionsStore.getState().toggleSelectedVersion(version)
				}
			}}
			title={simpleDate(Number(version.timestamp))}
			subtitle={formatBytes(Number(version.size))}
			trailing={
				<Menu
					type="dropdown"
					buttons={[
						{
							id: "select",
							title: isSelected ? t("deselect") : t("select"),
							icon: "select",
							checked: isSelected,
							onPress: () => {
								useFileVersionsStore.getState().toggleSelectedVersion(version)
							}
						},
						{
							id: "restore",
							title: t("restore"),
							icon: "restore",
							requiresOnline: true,
							onPress: async () => {
								const promptResponse = await run(async () => {
									return await prompts.alert({
										title: t("restore_version"),
										message: t("restore_version_confirmation"),
										cancelText: t("cancel"),
										okText: t("restore"),
										destructive: true
									})
								})

								if (!promptResponse.success) {
									console.error(promptResponse.error)
									alerts.error(promptResponse.error)

									return
								}

								if (promptResponse.data.cancelled) {
									return
								}

								const result = await runWithLoading(async () => {
									await drive.restoreFileVersion({
										item,
										version
									})
								})

								if (!result.success) {
									console.error(result.error)
									alerts.error(result.error)

									return
								}
							}
						},
						{
							id: "delete",
							title: t("delete"),
							icon: "delete",
							destructive: true,
							requiresOnline: true,
							onPress: async () => {
								const promptResponse = await run(async () => {
									return await prompts.alert({
										title: t("delete_version"),
										message: t("delete_version_confirmation"),
										cancelText: t("cancel"),
										okText: t("delete"),
										destructive: true
									})
								})

								if (!promptResponse.success) {
									console.error(promptResponse.error)
									alerts.error(promptResponse.error)

									return
								}

								if (promptResponse.data.cancelled) {
									return
								}

								const result = await runWithLoading(async () => {
									await drive.deleteVersion({
										item,
										version
									})
								})

								if (!result.success) {
									console.error(result.error)
									alerts.error(result.error)

									return
								}
							}
						}
					]}
				>
					<EllipsisMenuTrigger />
				</Menu>
			}
		/>
	)
}

const FileVersionsHeader = ({ versions, item }: { versions: FileVersion[]; item: DriveItem }) => {
	const { t } = useTranslation()
	const bgBackgroundSecondary = useResolveClassNames("bg-background-secondary")
	const textForeground = useResolveClassNames("text-foreground")
	const navigation = useNavigation()
	const isOnline = useIsOnline()
	const selectedVersions = useFileVersionsStore(useShallow(state => state.selectedVersions))

	const inSelectionMode = selectedVersions.length > 0

	const rightItems = ((): HeaderItem[] | undefined => {
		if (inSelectionMode) {
			const menuButtons: MenuButton[] = [
				{
					id: "selectAll",
					title: selectedVersions.length === versions.length ? t("deselect_all") : t("select_all"),
					icon: "select",
					onPress: () => {
						if (selectedVersions.length === versions.length) {
							useFileVersionsStore.getState().clearSelectedVersions()

							return
						}

						useFileVersionsStore.getState().selectAllVersions(versions)
					}
				},
				{
					id: "bulkDelete",
					title: t("delete_selected"),
					icon: "delete",
					destructive: true,
					requiresOnline: true,
					onPress: async () => {
						await runBulk({
							items: selectedVersions,
							clearSelection: () => useFileVersionsStore.getState().clearSelectedVersions(),
							confirm: {
								title: t("delete_selected"),
								message: t("delete_selected_versions_confirmation"),
								okText: t("delete"),
								cancelText: t("cancel"),
								destructive: true
							},
							op: version => drive.deleteVersion({ item, version })
						})
					}
				}
			]

			return [
				{
					type: "menu",
					props: {
						type: "dropdown",
						hitSlop: 20,
						buttons: menuButtons
					},
					triggerProps: {
						hitSlop: 20
					},
					icon: {
						name: "ellipsis-horizontal",
						size: 24,
						color: textForeground.color
					}
				}
			]
		}

		if (versions.length === 0) {
			return undefined
		}

		return [
			{
				type: "button",
				icon: {
					name: "trash-bin-outline",
					color: textForeground.color,
					size: 20
				},
				props: {
					enabled: isOnline,
					style: !isOnline ? { opacity: 0.5 } : undefined,
					onPress: async () => {
						const promptResponse = await run(async () => {
							return await prompts.alert({
								title: t("delete_all_versions"),
								message: t("delete_all_versions_confirmation"),
								cancelText: t("cancel"),
								okText: t("delete_all"),
								destructive: true
							})
						})

						if (!promptResponse.success) {
							console.error(promptResponse.error)
							alerts.error(promptResponse.error)

							return
						}

						if (promptResponse.data.cancelled) {
							return
						}

						const result = await runWithLoading(async () => {
							await Promise.all(
								versions.map(version => {
									return drive.deleteVersion({
										item,
										version
									})
								})
							)
						})

						if (!result.success) {
							console.error(result.error)
							alerts.error(result.error)

							return
						}
					}
				}
			}
		]
	})()

	const leftItems: HeaderItem[] = (() => {
		if (inSelectionMode) {
			return [
				{
					type: "button",
					icon: {
						name: "close-outline",
						color: textForeground.color,
						size: 20
					},
					props: {
						onPress: () => {
							useFileVersionsStore.getState().clearSelectedVersions()
						}
					}
				}
			]
		}

		if (Platform.OS === "ios") {
			return [
				{
					type: "button",
					icon: {
						name: "close",
						color: textForeground.color,
						size: 20
					},
					props: {
						onPress: () => {
							navigation.getParent()?.goBack()
						}
					}
				}
			]
		}

		return []
	})()

	return (
		<Header
			title={inSelectionMode ? t("selected", { count: selectedVersions.length }) : t("file_versions")}
			transparent={Platform.OS === "ios"}
			shadowVisible={false}
			backVisible={Platform.OS === "android"}
			backgroundColor={Platform.select({
				ios: undefined,
				default: bgBackgroundSecondary.backgroundColor as string
			})}
			leftItems={leftItems}
			rightItems={rightItems}
		/>
	)
}

const FileVersions = () => {
	const { t } = useTranslation()
	const { item: itemSerialized } = useLocalSearchParams<{
		item?: string
	}>()
	const insets = useSafeAreaInsets()

	useFocusEffect(
		useCallback(() => {
			useFileVersionsStore.getState().clearSelectedVersions()

			return () => {
				useFileVersionsStore.getState().clearSelectedVersions()
			}
		}, [])
	)

	const item = deserializeRouteParam<DriveItem>(itemSerialized)

	const driveItemVersionsQuery = useDriveItemVersionsQuery(
		{
			uuid: item?.data.uuid ?? ""
		},
		{
			enabled: !!item && item.type === "file"
		}
	)

	const versions =
		driveItemVersionsQuery.status === "success" && item
			? driveItemVersionsQuery.data.filter(version => version.uuid !== item.data.uuid)
			: []

	if (!item || item.type !== "file") {
		return <DismissStack />
	}

	return (
		<Fragment>
			<FileVersionsHeader
				versions={versions}
				item={item}
			/>
			<SafeAreaView
				className="flex-1 bg-background-secondary"
				edges={["left", "right"]}
			>
				<VirtualList
					data={versions}
					loading={driveItemVersionsQuery.status !== "success"}
					contentInsetAdjustmentBehavior="automatic"
					contentContainerStyle={{
						paddingBottom: insets.bottom
					}}
					onRefresh={async () => {
						if (!onlineManager.isOnline()) {
							return
						}

						const result = await run(async () => {
							return await driveItemVersionsQuery.refetch()
						})

						if (!result.success) {
							console.error(result.error)
							alerts.error(result.error)
						}
					}}
					emptyComponent={() => (
						<ListEmpty
							icon="time-outline"
							title={t("no_file_versions")}
						/>
					)}
					renderItem={({ item: version }) => {
						return (
							<Version
								version={version}
								item={item}
							/>
						)
					}}
					keyExtractor={version => version.uuid}
				/>
			</SafeAreaView>
		</Fragment>
	)
}

export default FileVersions
