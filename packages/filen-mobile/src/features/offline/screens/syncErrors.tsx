import Text from "@/components/ui/text"
import { router } from "@/lib/router"
import { ScreenBody } from "@/components/ui/safeAreaView"
import ListEmpty from "@/components/ui/listEmpty"
import SettingsHeader from "@/components/ui/settingsHeader"
import { Fragment } from "react"
import VirtualList from "@/components/ui/virtualList"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import useOfflineStore from "@/features/offline/store/useOffline.store"
import { useShallow } from "zustand/shallow"
import logger from "@/lib/logger"
import offlineSync from "@/features/offline/offlineSync"
import { useTranslation } from "react-i18next"
import ListRow from "@/components/ui/listRow"
import { ItemGlyph } from "@/components/itemIcons"
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
				<ItemGlyph
					isDirectory={DIRECTORY_TYPES.has(error.itemType)}
					name={error.name}
				/>
			}
			title={error.name}
			subtitle={<Text className="text-muted-foreground text-xs">{`${kindLabel} · ${error.message}`}</Text>}
		/>
	)
}

const SyncErrors = () => {
	const { t } = useTranslation()
	const insets = useSafeAreaInsets()
	const syncErrors = useOfflineStore(useShallow(state => state.syncErrors))

	return (
		<Fragment>
			<SettingsHeader
				title={t("offline_sync_errors")}
				icon="chevron-back-outline"
				onDismiss={() => {
					router.back()
				}}
				rightItems={[
					{
						type: "ellipsisMenu",
						buttons: [
							{
								id: "clear",
								icon: "trash",
								title: t("clear_errors"),
								onPress: () => {
									useOfflineStore.getState().setSyncErrors([])
	
									offlineSync.sync({ manual: true }).catch(err => logger.warn("offline-sync", "Manual sync after clearing errors failed", { error: err }))
								}
							},
							{
								id: "settings",
								icon: "gear",
								title: t("settings"),
								onPress: () => {
									router.push("/offlineSettings")
								}
							}
						]
					}
				]}
			/>
			<ScreenBody>
				<VirtualList
					data={syncErrors}
					contentContainerStyle={{
						paddingBottom: insets.bottom
					}}
					emptyComponent={() => (
						<ListEmpty
							icon="checkmark-outline"
							title={t("no_offline_sync_errors")}
							description={t("no_offline_sync_errors_description")}
						/>
					)}
					renderItem={({ item: error }) => {
						return <Err error={error} />
					}}
					keyExtractor={error => error.id}
				/>
			</ScreenBody>
		</Fragment>
	)
}

export default SyncErrors
