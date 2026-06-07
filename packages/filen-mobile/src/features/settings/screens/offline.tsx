import { SettingsScrollView } from "@/components/ui/settingsScrollView"
import SafeAreaView from "@/components/ui/safeAreaView"
import { Group } from "@/components/ui/settingsGroup"
import { Fragment } from "react"
import { useNavigation } from "expo-router"
import SettingsHeader from "@/components/ui/settingsHeader"
import { useSecureStore } from "@/lib/secureStore"
import { OFFLINE_SYNC_WIFI_ONLY_SECURE_STORE_KEY } from "@/features/offline/offlineHelpers"
import { useTranslation } from "react-i18next"

function OfflineSettings() {
	const navigation = useNavigation()
	const { t } = useTranslation()
	const [wifiOnly, setWifiOnly] = useSecureStore<boolean>(OFFLINE_SYNC_WIFI_ONLY_SECURE_STORE_KEY, false)

	return (
		<Fragment>
			<SettingsHeader
				title={t("offline")}
				icon="close"
				onDismiss={() => {
					navigation.getParent()?.goBack()
				}}
			/>
			<SafeAreaView
				className="flex-1 bg-background-secondary"
				edges={["left", "right"]}
			>
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
							}
						]}
					/>
				</SettingsScrollView>
			</SafeAreaView>
		</Fragment>
	)
}

export default OfflineSettings
