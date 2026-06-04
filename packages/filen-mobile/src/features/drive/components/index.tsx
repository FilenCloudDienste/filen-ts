import { Fragment, useCallback } from "react"
import { useTranslation } from "react-i18next"
import SafeAreaView from "@/components/ui/safeAreaView"
import useDrivePath from "@/hooks/useDrivePath"
import useDriveItemsQuery from "@/features/drive/queries/useDriveItems.query"
import type { DriveItem } from "@/types"
import { itemSorter } from "@/lib/sort"
import { useDriveSortPreference } from "@/features/drive/driveSortPreference"
import VirtualList, { type ListRenderItemInfo } from "@/components/ui/virtualList"
import ListEmpty from "@/components/ui/listEmpty"
import Item from "@/features/drive/components/item"
import Header from "@/features/drive/components/header"
import { run, cn } from "@filen/utils"
import alerts from "@/lib/alerts"
import { Platform } from "react-native"
import { useFocusEffect } from "expo-router"
import useDriveStore from "@/features/drive/store/useDrive.store"
import { onlineManager } from "@tanstack/react-query"
import { driveItemDisplayName } from "@/lib/decryption"
import { useDriveSearch } from "@/features/drive/hooks/useDriveSearch"
import { getDriveEmptyStateIcon, getDriveEmptyStateTitleKey } from "@/features/drive/utils"

const Drive = () => {
	const drivePath = useDrivePath()
	const { t } = useTranslation()
	const { searchQuery, setSearchQuery, globalSearchResult, queryingGlobalSearch } = useDriveSearch({ drivePath })
	const { sort } = useDriveSortPreference(drivePath)

	const driveItemsQuery = useDriveItemsQuery(
		{
			path: drivePath
		},
		{
			enabled: drivePath.type !== null
		}
	)

	const itemsSorted = itemSorter.sortItems(
		[...(driveItemsQuery.status === "success" ? driveItemsQuery.data : []), ...globalSearchResult],
		sort
	)

	const items = (() => {
		if (driveItemsQuery.status !== "success") {
			return []
		}

		if (searchQuery.length > 0) {
			const searchQueryNormalized = searchQuery.trim().toLowerCase()

			return itemsSorted.filter(item => {
				// driveItemDisplayName returns `cannot_decrypt_<uuid>` for undecryptable
				// items so they remain searchable via the placeholder text.
				if (driveItemDisplayName(item).toLowerCase().includes(searchQueryNormalized)) {
					return true
				}

				return false
			})
		}

		return itemsSorted
	})()

	useFocusEffect(
		useCallback(() => {
			useDriveStore.getState().clearSelectedItems()

			return () => {
				useDriveStore.getState().clearSelectedItems()
			}
		}, [])
	)

	return (
		<Fragment>
			<Header setSearchQuery={setSearchQuery} />
			<SafeAreaView
				className={cn(
					"flex-1",
					drivePath.type === "drive" && !drivePath.selectOptions ? "bg-background" : "bg-background-secondary"
				)}
				edges={["left", "right"]}
			>
				<VirtualList
					className={cn(
						"flex-1",
						drivePath.type === "drive" && !drivePath.selectOptions ? "bg-background" : "bg-background-secondary"
					)}
					contentInsetAdjustmentBehavior="automatic"
					contentContainerClassName={cn("pb-40", Platform.OS === "android" && "pb-96")}
					keyExtractor={(item: DriveItem) => {
						return item.data.uuid
					}}
					data={items}
					renderItem={(info: ListRenderItemInfo<DriveItem>) => {
						return (
							<Item
								info={info}
								drivePath={drivePath}
								getListItems={() => items}
							/>
						)
					}}
					onRefresh={async () => {
						if (!onlineManager.isOnline()) {
							return
						}

						const result = await run(async () => {
							return await driveItemsQuery.refetch()
						})

						if (!result.success) {
							console.error(result.error)
							alerts.error(result.error)
						}
					}}
					loading={driveItemsQuery.status !== "success" || queryingGlobalSearch}
					emptyComponent={() => (
						<ListEmpty
							icon={getDriveEmptyStateIcon(drivePath.type)}
							title={t(getDriveEmptyStateTitleKey(drivePath.type))}
						/>
					)}
				/>
			</SafeAreaView>
		</Fragment>
	)
}

export default Drive
