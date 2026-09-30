import { ScreenBody } from "@/components/ui/safeAreaView"
import { Group } from "@/components/ui/settingsGroup"
import { Fragment } from "react"
import { goBackIfPossible } from "@/lib/router"
import SettingsHeader from "@/components/ui/settingsHeader"
import { useSecureStore } from "@/lib/secureStore"
import useLocalAuthenticationQuery from "@/queries/useLocalAuthentication.query"
import { actionSheet } from "@/providers/actionSheet.provider"
import { FILE_PROVIDER_ENABLED_SECURE_STORE_KEY } from "@/features/settings/fileProvider"
import { useTranslation } from "react-i18next"
import { LoadingView } from "@/components/ui/loadingView"
import { SettingsScrollView } from "@/components/ui/settingsScrollView"
import { enableBiometric } from "@/features/settings/biometricButtons"
import { type Biometric, useBiometric } from "@/features/settings/biometric"
import ListEmpty from "@/components/ui/listEmpty"
import { type en } from "@/locales/en"

const LOCK_AFTER_OPTIONS = [
	{ seconds: 0, labelKey: "immediately" },
	{ seconds: 60, labelKey: "one_minute" },
	{ seconds: 60 * 5, labelKey: "five_minutes" },
	{ seconds: 60 * 15, labelKey: "fifteen_minutes" },
	{ seconds: 60 * 30, labelKey: "thirty_minutes" },
	{ seconds: 60 * 60, labelKey: "one_hour" }
] as const satisfies readonly { seconds: number; labelKey: keyof typeof en }[]

function BiometricComponent() {
	const { t } = useTranslation()
	const [biometric, setBiometric] = useBiometric()
	const [fileProviderEnabled, setFileProviderEnabled] = useSecureStore<boolean>(FILE_PROVIDER_ENABLED_SECURE_STORE_KEY, false)
	const localAuthenticationQuery = useLocalAuthenticationQuery()

	return (
		<Fragment>
			<SettingsHeader
				title={t("biometric_authentication")}
				icon="chevron-back-outline"
				onDismiss={goBackIfPossible}
			/>
			<ScreenBody>
				{localAuthenticationQuery.status === "success" ? (
					localAuthenticationQuery.data.hasHardware && localAuthenticationQuery.data.isEnrolled ? (
						<SettingsScrollView>
							<Group
								buttons={[
									{
										icon: "finger-print-outline",
										title: t("biometric_authentication"),
										subTitle: t("biometric_authentication_description"),
										rightItem: {
											type: "switch",
											value: biometric.enabled,
											onValueChange: async () => {
												if (biometric.enabled) {
													setBiometric({ enabled: false })

													return
												}

												await enableBiometric({
													setBiometric,
													fileProviderEnabled,
													setFileProviderEnabled,
													t
												})
											}
										}
									}
								]}
							/>
							{biometric.enabled && (
								<Group
									buttons={[
										{
											icon: "keypad-outline",
											title: t("pin_only"),
											subTitle: t("pin_only_description"),
											rightItem: {
												type: "switch",
												value: biometric.pinOnly,
												onValueChange: () => {
													setBiometric(prev => {
														if (!prev.enabled) {
															return prev
														}

														return {
															...prev,
															pinOnly: !prev.pinOnly
														} satisfies Biometric
													})
												}
											}
										},
										{
											icon: "time-outline",
											title: t("lock_app_after"),
											subTitle: t(
												LOCK_AFTER_OPTIONS.find(option => option.seconds === biometric.lockAfter)?.labelKey ??
													"lock_app_after_description"
											),
											onPress: () => {
												actionSheet.show({
													buttons: LOCK_AFTER_OPTIONS.map(option => ({
														title: t(option.labelKey),
														onPress: () => {
															setBiometric(prev => {
																if (!prev.enabled) {
																	return prev
																}

																return {
																	...prev,
																	lockAfter: option.seconds
																} satisfies Biometric
															})
														}
													}))
												})
											}
										}
									]}
								/>
							)}
						</SettingsScrollView>
					) : (
						<ListEmpty
							icon="finger-print-outline"
							title={t("biometric_not_supported")}
						/>
					)
				) : (
					<LoadingView />
				)}
			</ScreenBody>
		</Fragment>
	)
}

export default BiometricComponent
