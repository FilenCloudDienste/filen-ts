import { SettingsScrollView } from "@/components/ui/settingsScrollView"
import { ScreenBody } from "@/components/ui/safeAreaView"
import { Group } from "@/components/ui/settingsGroup"
import { Fragment } from "react"
import useDismissStack from "@/hooks/useDismissStack"
import SettingsHeader from "@/components/ui/settingsHeader"
import { useSecureStore } from "@/lib/secureStore"
import { OFFLINE_SYNC_WIFI_ONLY_SECURE_STORE_KEY, OFFLINE_BACKGROUND_SYNC_SECURE_STORE_KEY } from "@/features/offline/offlineHelpers"
import { useTranslation } from "react-i18next"

function OfflineSettings() {
	const dismiss = useDismissStack()
	const { t } = useTranslation()
	const [wifiOnly, setWifiOnly] = useSecureStore<boolean>(OFFLINE_SYNC_WIFI_ONLY_SECURE_STORE_KEY, false)
	const [backgroundSync, setBackgroundSync] = useSecureStore<boolean>(OFFLINE_BACKGROUND_SYNC_SECURE_STORE_KEY, false)

	return (
		<Fragment>
			<SettingsHeader
				title={t("offline")}
				icon="close"
				onDismiss={dismiss}
			/>
			<ScreenBody>
				<SettingsScrollView>
					<Group
						className="bg-background-tertiary"
						buttons={[
							{
								icon: "wifi-outline",
								title: t("sync_offline_on_wifi_only"),
								subTitle: t("sync_offline_on_wifi_only_description"),
								rightItem: {
									type: "switch",
									value: wifiOnly,
									onValueChange: () => {
										setWifiOnly(prev => !prev)
									}
								}
							},
							{
								icon: "cloud-download-outline",
								title: t("sync_offline_in_background"),
								subTitle: t("sync_offline_in_background_description"),
								rightItem: {
									type: "switch",
									value: backgroundSync,
									onValueChange: () => {
										setBackgroundSync(prev => !prev)
									}
								}
							}
						]}
					/>
				</SettingsScrollView>
			</ScreenBody>
		</Fragment>
	)
}

export default OfflineSettings
