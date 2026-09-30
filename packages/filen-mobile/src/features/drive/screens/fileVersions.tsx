import { useLocalSearchParams } from "expo-router"
import useDismissStack from "@/hooks/useDismissStack"
import { deserializeRouteParam } from "@/lib/serializer"
import type { DriveItem } from "@/types"
import { ScreenBody } from "@/components/ui/safeAreaView"
import ListEmpty from "@/components/ui/listEmpty"
import { type HeaderItem } from "@/components/ui/header"
import SettingsHeader from "@/components/ui/settingsHeader"
import { Fragment } from "react"
import { useTranslation } from "react-i18next"
import { useResolveClassNames } from "uniwind"
import { run, formatBytes } from "@filen/shared"
import useDriveItemVersionsQuery from "@/features/drive/queries/useDriveItemVersions.query"
import VirtualList from "@/components/ui/virtualList"
import { simpleDate } from "@/lib/time"
import drive from "@/features/drive/drive"
import alerts from "@/lib/alerts"
import { confirmedAction } from "@/lib/confirmedAction"
import type { FileVersion } from "@filen/sdk-rs"
import Menu, { type MenuButton } from "@/components/ui/menu"
import { selectAllMenuButton } from "@/components/ui/selectAllMenuButton"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import DismissStack from "@/components/dismissStack"
import useFileVersionsStore from "@/features/drive/store/useFileVersions.store"
import { useShallow } from "zustand/shallow"
import { runBulk } from "@/lib/bulkOps"
import EllipsisMenuTrigger from "@/components/ui/ellipsisMenuTrigger"
import ListRow from "@/components/ui/listRow"
import useIsOnline from "@/hooks/useIsOnline"
import useClearSelectionOnFocusChange from "@/hooks/useClearSelectionOnFocusChange"
import logger from "@/lib/logger"

const clearSelectedVersions = () => useFileVersionsStore.getState().clearSelectedVersions()

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
							onPress: confirmedAction({
								promptTitle: t("restore_version"),
								promptMessage: t("restore_version_confirmation"),
								promptOkText: t("restore"),
								action: () => drive.restoreFileVersion({ item, version })
							})
						},
						{
							id: "delete",
							title: t("delete"),
							icon: "delete",
							destructive: true,
							requiresOnline: true,
							onPress: confirmedAction({
								promptTitle: t("delete_version"),
								promptMessage: t("delete_version_confirmation"),
								promptOkText: t("delete"),
								action: () => drive.deleteVersion({ item, version })
							})
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
	const textForeground = useResolveClassNames("text-foreground")
	const dismiss = useDismissStack()
	const isOnline = useIsOnline()
	const selectedVersions = useFileVersionsStore(useShallow(state => state.selectedVersions))

	const inSelectionMode = selectedVersions.length > 0

	const rightItems = ((): HeaderItem[] | undefined => {
		if (inSelectionMode) {
			const menuButtons: MenuButton[] = [
				selectAllMenuButton({
					t,
					allSelected: selectedVersions.length === versions.length,
					onClear: () => useFileVersionsStore.getState().clearSelectedVersions(),
					onSelectAll: () => useFileVersionsStore.getState().selectAllVersions(versions)
				}),
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
					type: "ellipsisMenu",
					buttons: menuButtons
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
					onPress: confirmedAction({
						promptTitle: t("delete_all_versions"),
						promptMessage: t("delete_all_versions_confirmation"),
						promptOkText: t("delete_all"),
						action: () => Promise.all(versions.map(version => drive.deleteVersion({ item, version })))
					})
				}
			}
		]
	})()

	const leftItems: HeaderItem[] | undefined = inSelectionMode
		? [
				{
					type: "clearSelection",
					onPress: () => useFileVersionsStore.getState().clearSelectedVersions()
				}
			]
		: undefined

	return (
		<SettingsHeader
			title={inSelectionMode ? t("selected", { count: selectedVersions.length }) : t("file_versions")}
			icon="close"
			onDismiss={dismiss}
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

	useClearSelectionOnFocusChange(clearSelectedVersions)

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
		driveItemVersionsQuery.data && item
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
			<ScreenBody>
				<VirtualList
					data={versions}
					loading={driveItemVersionsQuery.status === "pending"}
					contentContainerStyle={{
						paddingBottom: insets.bottom
					}}
					requiresOnline={true}
					onRefresh={async () => {
						const result = await run(async () => {
							return await driveItemVersionsQuery.refetch()
						})

						if (!result.success) {
							logger.error("drive", "file versions refresh failed", { error: result.error })
							alerts.error(result.error)
						}
					}}
					emptyComponent={() => (
						<ListEmpty
							icon="time-outline"
							title={t("no_file_versions")}
							description={t("no_file_versions_description")}
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
			</ScreenBody>
		</Fragment>
	)
}

export default FileVersions
