import Text from "@/components/ui/text"
import { Platform } from "react-native"
import { onlineManager } from "@tanstack/react-query"
import { useLocalSearchParams, useNavigation, useFocusEffect } from "expo-router"
import { deserializeRouteParam } from "@/lib/serializer"
import type { DriveItem } from "@/types"
import View from "@/components/ui/view"
import SafeAreaView from "@/components/ui/safeAreaView"
import ListEmpty from "@/components/ui/listEmpty"
import Header, { type HeaderItem } from "@/components/ui/header"
import { Fragment, useCallback } from "react"
import { useTranslation } from "react-i18next"
import { useResolveClassNames } from "uniwind"
import { run, formatBytes, cn } from "@filen/utils"
import useDriveItemVersionsQuery from "@/features/drive/queries/useDriveItemVersions.query"
import VirtualList from "@/components/ui/virtualList"
import { simpleDate } from "@/lib/time"
import drive from "@/features/drive/drive"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import alerts from "@/lib/alerts"
import prompts from "@/lib/prompts"
import type { FileVersion } from "@filen/sdk-rs"
import Menu, { type MenuButton } from "@/components/ui/menu"
import { PressableScale } from "@/components/ui/pressables"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import DismissStack from "@/components/dismissStack"
import useFileVersionsStore from "@/features/drive/store/useFileVersions.store"
import { useShallow } from "zustand/shallow"
import { runBulk } from "@/lib/bulkOps"
import { Checkbox } from "@/components/ui/checkbox"
import { AnimatedView } from "@/components/ui/animated"
import { FadeIn, FadeOut } from "react-native-reanimated"
import EllipsisMenuTrigger from "@/components/ui/ellipsisMenuTrigger"

const Version = ({ version, item }: { version: FileVersion; item: DriveItem }) => {
	const { t } = useTranslation()
	const isSelected = useFileVersionsStore(useShallow(state => state.selectedVersions.some(v => v.uuid === version.uuid)))
	const areVersionsSelected = useFileVersionsStore(useShallow(state => state.selectedVersions.length > 0))

	return (
		<View className={cn("flex-row items-center px-4 bg-transparent", isSelected && "bg-background-tertiary")}>
			<View className="flex-row items-center gap-4 py-2 bg-transparent border-b border-border flex-1">
				{areVersionsSelected && (
					<AnimatedView
						className="flex-row h-full items-center justify-center bg-transparent pr-1 shrink-0"
						entering={FadeIn}
						exiting={FadeOut}
					>
						<Checkbox value={isSelected} />
					</AnimatedView>
				)}
				<PressableScale
					className="flex-row flex-1 bg-transparent"
					onPress={() => {
						if (areVersionsSelected) {
							useFileVersionsStore.getState().toggleSelectedVersion(version)
						}
					}}
				>
					<View className="flex-col bg-transparent flex-1 gap-0.5">
						<Text
							className="text-foreground"
							numberOfLines={1}
							ellipsizeMode="middle"
						>
							{simpleDate(Number(version.timestamp))}
						</Text>
						<Text
							className="text-muted-foreground text-xs"
							numberOfLines={1}
							ellipsizeMode="middle"
						>
							{formatBytes(Number(version.size))}
						</Text>
					</View>
				</PressableScale>
				<View className="flex-row items-center gap-4 bg-transparent">
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
				</View>
			</View>
		</View>
	)
}

const FileVersionsHeader = ({ versions, item }: { versions: FileVersion[]; item: DriveItem }) => {
	const { t } = useTranslation()
	const bgBackgroundSecondary = useResolveClassNames("bg-background-secondary")
	const textForeground = useResolveClassNames("text-foreground")
	const navigation = useNavigation()
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
