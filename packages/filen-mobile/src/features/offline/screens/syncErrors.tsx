import Text from "@/components/ui/text"
import { Platform } from "react-native"
import { router } from "expo-router"
import SafeAreaView from "@/components/ui/safeAreaView"
import ListEmpty from "@/components/ui/listEmpty"
import Header, { type HeaderItem } from "@/components/ui/header"
import { Fragment } from "react"
import { useResolveClassNames } from "uniwind"
import VirtualList from "@/components/ui/virtualList"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import useOfflineStore from "@/features/offline/store/useOffline.store"
import { useShallow } from "zustand/shallow"
import offlineSync from "@/features/offline/offlineSync"
import { useTranslation } from "react-i18next"
import ListRow from "@/components/ui/listRow"
import { FileIcon, DirectoryIcon } from "@/components/itemIcons"
import { DIRECTORY_TYPES } from "@/features/drive/driveSelectors"
import { type OfflineSyncError } from "@/features/offline/offlineHelpers"

const Err = ({ error }: { error: OfflineSyncError }) => {
	const { t } = useTranslation()

	const kindLabel = (() => {
		switch (error.kind) {
			case "download": {
				return t("offline_sync_error_kind_download")
			}

			case "listing": {
				return t("offline_sync_error_kind_listing")
			}

			case "verify": {
				return t("offline_sync_error_kind_verify")
			}

			case "store": {
				return t("offline_sync_error_kind_store")
			}
		}
	})()

	return (
		<ListRow
			separator={true}
			density="relaxed"
			leading={
				DIRECTORY_TYPES.has(error.itemType) ? (
					<DirectoryIcon
						width={32}
						height={32}
					/>
				) : (
					<FileIcon
						name={error.name}
						width={32}
						height={32}
					/>
				)
			}
			title={error.name}
			subtitle={<Text className="text-muted-foreground text-xs">{`${kindLabel} · ${error.message}`}</Text>}
		/>
	)
}

const SyncErrors = () => {
	const { t } = useTranslation()
	const bgBackgroundSecondary = useResolveClassNames("bg-background-secondary")
	const textForeground = useResolveClassNames("text-foreground")
	const insets = useSafeAreaInsets()
	const syncErrors = useOfflineStore(useShallow(state => state.syncErrors))

	return (
		<Fragment>
			<Header
				title={t("offline_sync_errors")}
				transparent={Platform.OS === "ios"}
				shadowVisible={false}
				backVisible={Platform.OS === "android"}
				backgroundColor={Platform.select({
					ios: undefined,
					default: bgBackgroundSecondary.backgroundColor as string
				})}
				leftItems={Platform.select({
					ios: [
						{
							type: "button",
							icon: {
								name: "chevron-back-outline",
								color: textForeground.color,
								size: 20
							},
							props: {
								onPress: () => {
									router.back()
								}
							}
						}
					] satisfies HeaderItem[],
					default: undefined
				})}
				rightItems={[
					{
						type: "menu",
						props: {
							type: "dropdown",
							hitSlop: 20,
							buttons: [
								{
									id: "clear",
									icon: "edit",
									title: t("clear_errors"),
									onPress: () => {
										useOfflineStore.getState().setSyncErrors([])

										offlineSync.sync({ manual: true }).catch(console.error)
									}
								},
								{
									id: "settings",
									icon: "edit",
									title: t("settings"),
									onPress: () => {
										router.push("/offlineSettings")
									}
								}
							]
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
				]}
			/>
			<SafeAreaView
				className="flex-1 bg-background-secondary"
				edges={["left", "right"]}
			>
				<VirtualList
					data={syncErrors}
					contentInsetAdjustmentBehavior="automatic"
					contentContainerStyle={{
						paddingBottom: insets.bottom
					}}
					emptyComponent={() => (
						<ListEmpty
							icon="checkmark-outline"
							title={t("no_offline_sync_errors")}
						/>
					)}
					renderItem={({ item: error }) => {
						return <Err error={error} />
					}}
					keyExtractor={error => error.id}
				/>
			</SafeAreaView>
		</Fragment>
	)
}

export default SyncErrors
