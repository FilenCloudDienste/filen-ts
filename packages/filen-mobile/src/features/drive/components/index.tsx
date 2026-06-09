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
import Button from "@/components/ui/button"
import Item from "@/features/drive/components/item"
import Header from "@/features/drive/components/header"
import { run, cn } from "@filen/utils"
import alerts from "@/lib/alerts"
import { Platform } from "react-native"
import { useFocusEffect } from "expo-router"
import useDriveStore from "@/features/drive/store/useDrive.store"
import { onlineManager } from "@tanstack/react-query"
import { useDriveSearch } from "@/features/drive/hooks/useDriveSearch"
import { getDriveEmptyStateIcon, getDriveEmptyStateTitleKey, filterDriveItemsBySearchQuery, mergeByUuid } from "@/features/drive/utils"

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

	// #26 — use retained data unconditionally (stale-while-error); status "error"
	// with prior data keeps the listing visible instead of flipping to "empty".
	// #27 — de-dup local listing + global search by uuid before sorting so
	// FlashList never receives duplicate keys or inflated selection counts.
	const baseItems = driveItemsQuery.data ?? []
	const merged = mergeByUuid(baseItems, globalSearchResult)
	const itemsSorted = itemSorter.sortItems(merged, sort)
	const items = filterDriveItemsBySearchQuery(itemsSorted, searchQuery)

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
			<Header
				setSearchQuery={setSearchQuery}
				listItems={items}
				queryingGlobalSearch={queryingGlobalSearch}
			/>
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
						// The offline cache listing reads purely from local storage
						// (the query is networkMode: "always"), so pull-to-refresh must
						// work while offline. Every other variant hits the network.
						if (!onlineManager.isOnline() && drivePath.type !== "offline") {
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
					loading={driveItemsQuery.status === "pending"}
					emptyComponent={() => {
						// #26 — distinguish a query error with no retained data (show
						// error + retry) from a genuinely empty directory (existing empty
						// state). When data was retained through the error, items.length
						// will be > 0 and this component is not rendered at all.
						if (driveItemsQuery.status === "error") {
							return (
								<ListEmpty
									icon="alert-circle-outline"
									title={t("error_generic")}
									action={
										<Button onPress={() => void driveItemsQuery.refetch()}>{t("try_again")}</Button>
									}
								/>
							)
						}

						return (
							<ListEmpty
								icon={getDriveEmptyStateIcon(drivePath.type)}
								title={t(getDriveEmptyStateTitleKey(drivePath.type))}
							/>
						)
					}}
				/>
			</SafeAreaView>
		</Fragment>
	)
}

export default Drive
