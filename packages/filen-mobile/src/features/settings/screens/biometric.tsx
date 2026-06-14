import SafeAreaView from "@/components/ui/safeAreaView"
import { Group } from "@/components/ui/settingsGroup"
import { Fragment } from "react"
import { router } from "expo-router"
import SettingsHeader from "@/components/ui/settingsHeader"
import { useSecureStore } from "@/lib/secureStore"
import useLocalAuthenticationQuery from "@/queries/useLocalAuthentication.query"
import { actionSheet } from "@/providers/actionSheet.provider"
import { FILE_PROVIDER_ENABLED_SECURE_STORE_KEY } from "@/features/settings/fileProvider"
import { useTranslation } from "react-i18next"
import { SettingsLoadingView } from "@/components/ui/settingsLoadingView"
import { SettingsScrollView } from "@/components/ui/settingsScrollView"
import { disableBiometric, enableBiometric } from "@/features/settings/biometricButtons"
import { type TFunction } from "i18next"
import ListEmpty from "@/components/ui/listEmpty"

function getLockAfterLabel(lockAfter: number, t: TFunction): string {
	switch (lockAfter) {
		case 0:
			return t("immediately")
		case 60:
			return t("one_minute")
		case 60 * 5:
			return t("five_minutes")
		case 60 * 15:
			return t("fifteen_minutes")
		case 60 * 30:
			return t("thirty_minutes")
		case 60 * 60:
			return t("one_hour")
		default:
			return t("lock_app_after_description")
	}
}

export type Biometric =
	| {
			enabled: false
	  }
	| {
			enabled: true
			fallback: string
			lockAfter: number
			lockedUntil: number
			lockedMultiplier: number
			pinOnly: boolean
	  }

function BiometricComponent() {
	const { t } = useTranslation()
	const [biometric, setBiometric] = useSecureStore<Biometric>("biometric", {
		enabled: false
	})
	const [fileProviderEnabled, setFileProviderEnabled] = useSecureStore<boolean>(FILE_PROVIDER_ENABLED_SECURE_STORE_KEY, false)
	const localAuthenticationQuery = useLocalAuthenticationQuery()

	return (
		<Fragment>
			<SettingsHeader
				title={t("biometric_authentication")}
				icon="chevron-back-outline"
				onDismiss={() => {
					if (router.canGoBack()) {
						router.back()
					}
				}}
			/>
			<SafeAreaView
				className="flex-1 bg-background-secondary"
				edges={["left", "right"]}
			>
				{localAuthenticationQuery.status === "success" ? (
					localAuthenticationQuery.data.hasHardware && localAuthenticationQuery.data.isEnrolled ? (
						<SettingsScrollView>
							<Group
								className="bg-background-tertiary"
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
													disableBiometric({ setBiometric })

													return
												}

												await enableBiometric({
													biometric,
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
									className="bg-background-tertiary"
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
											subTitle: getLockAfterLabel(biometric.lockAfter, t),
											onPress: () => {
												actionSheet.show({
													buttons: [
														...[
															{
																title: t("immediately"),
																seconds: 0
															},
															{
																title: t("one_minute"),
																seconds: 60
															},
															{
																title: t("five_minutes"),
																seconds: 60 * 5
															},
															{
																title: t("fifteen_minutes"),
																seconds: 60 * 15
															},
															{
																title: t("thirty_minutes"),
																seconds: 60 * 30
															},
															{
																title: t("one_hour"),
																seconds: 60 * 60
															}
														].map(option => ({
															title: option.title,
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
														})),
														{
															title: t("close"),
															cancel: true
														}
													]
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
					<SettingsLoadingView />
				)}
			</SafeAreaView>
		</Fragment>
	)
}

export default BiometricComponent
