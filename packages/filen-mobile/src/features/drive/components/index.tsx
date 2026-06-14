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
import {
	getDriveEmptyStateIcon,
	getDriveEmptyStateTitleKey,
	getDriveEmptyStateDescriptionKey,
	filterDriveItemsBySearchQuery,
	mergeByUuid
} from "@/features/drive/utils"
import offlineSync from "@/features/offline/offlineSync"
import SyncErrorsHeaderRow from "@/features/offline/components/syncErrorsHeaderRow"
import { LazyWrapper } from "@/components/lazyWrapper"
import { getDriveParent, canShowDriveCreateMenu, buildDriveCreateMenuButtons } from "@/features/drive/components/driveCreateMenu"
import { useDriveUpload } from "@/features/drive/hooks/useDriveUpload"
import Menu from "@/components/ui/menu"
import { PressableScale } from "@/components/ui/pressables"
import Text from "@/components/ui/text"
import Ionicons from "@expo/vector-icons/Ionicons"
import { useResolveClassNames } from "uniwind"

const Drive = () => {
	const drivePath = useDrivePath()
	const { t } = useTranslation()
	const { searchQuery, setSearchQuery, globalSearchResult, queryingGlobalSearch } = useDriveSearch({ drivePath })
	const { sort } = useDriveSortPreference(drivePath)
	const parent = getDriveParent(drivePath)
	const upload = useDriveUpload({ parent, drivePath, t })
	const primaryColor = useResolveClassNames("bg-primary").backgroundColor as string
	const driveCreateButtons = canShowDriveCreateMenu({ drivePath, parent, selectionMode: false })
		? buildDriveCreateMenuButtons({ t, parent, upload })
		: []

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
				{/*  disabled={!(drivePath.type === "drive" && !drivePath.uuid && !drivePath.selectOptions && !drivePath.linked)} */}
				<LazyWrapper>
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
						// Offline VIRTUAL ROOT only (nested offline dirs have a uuid): surfaces
						// the last sync pass's error count as a pressable row above the listing.
						// The row hides itself while there are no errors.
						headerComponent={drivePath.type === "offline" && !drivePath.uuid ? () => <SyncErrorsHeaderRow /> : undefined}
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

							// Manual offline-cache sync on pull-to-refresh — fire-and-forget
							// so the gesture resolves with the local listing refetch;
							// offlineSync gates connectivity/Wi-Fi-only internally.
							if (drivePath.type === "offline") {
								offlineSync.sync({ manual: true }).catch(console.error)
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
										title={t("could_not_load_directory")}
										description={t("please_check_connection")}
										action={<Button onPress={() => void driveItemsQuery.refetch()}>{t("try_again")}</Button>}
									/>
								)
							}

							if (searchQuery.trim().length > 0) {
								return (
									<ListEmpty
										icon="search-outline"
										title={t("no_results")}
										description={t("no_results_description")}
									/>
								)
							}

							return (
								<ListEmpty
									icon={getDriveEmptyStateIcon(drivePath.type)}
									title={t(getDriveEmptyStateTitleKey(drivePath.type))}
									description={t(getDriveEmptyStateDescriptionKey(drivePath.type))}
									action={
										driveCreateButtons.length > 0 ? (
											<Menu
												type="dropdown"
												buttons={driveCreateButtons}
											>
												<PressableScale className="flex-row items-center gap-1.5 px-4 py-2">
													<Ionicons
														name="add"
														size={20}
														color={primaryColor}
													/>
													<Text
														style={{ color: primaryColor }}
														className="text-base font-medium"
													>
														{t("add")}
													</Text>
												</PressableScale>
											</Menu>
										) : undefined
									}
								/>
							)
						}}
					/>
				</LazyWrapper>
			</SafeAreaView>
		</Fragment>
	)
}

export default Drive
