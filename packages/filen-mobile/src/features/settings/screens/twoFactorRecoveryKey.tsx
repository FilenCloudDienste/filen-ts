import { ScreenBody } from "@/components/ui/safeAreaView"
import View from "@/components/ui/view"
import Text from "@/components/ui/text"
import Button from "@/components/ui/button"
import ListEmpty from "@/components/ui/listEmpty"
import { SettingsScrollView } from "@/components/ui/settingsScrollView"
import { Fragment } from "react"
import { Platform } from "react-native"
import { useLocalSearchParams } from "expo-router"
import { goBackIfPossible } from "@/lib/router"
import { run } from "@filen/shared"
import SettingsHeader from "@/components/ui/settingsHeader"
import { copyToClipboard } from "@/lib/clipboard"
import { useTranslation } from "react-i18next"
import alerts from "@/lib/alerts"
import { shareTmpFile } from "@/lib/share"
import { writeTmpFile } from "@/lib/tmp"
import logger from "@/lib/logger"

function TwoFactorRecoveryKey() {
	const { t } = useTranslation()
	const { recoveryKey } = useLocalSearchParams<{ recoveryKey?: string }>()

	return (
		<Fragment>
			<SettingsHeader
				title={t("two_factor_recovery_key")}
				icon="chevron-back-outline"
				onDismiss={goBackIfPossible}
			/>
			<ScreenBody>
				{!recoveryKey || recoveryKey.length === 0 ? (
					<ListEmpty
						icon="warning-outline"
						title={t("two_factor_recovery_key_unavailable")}
						description={t("two_factor_recovery_key_unavailable_description")}
					/>
				) : (
					<SettingsScrollView>
						<View className="bg-transparent flex-col gap-6 px-4 pt-4">
							<Text className="text-muted-foreground text-base leading-6">
								{t("two_factor_recovery_key_save_description")}
							</Text>
							<View className="bg-background-tertiary rounded-2xl p-4">
								<Text
									selectable={true}
									className="text-foreground text-base leading-6"
									style={{
										fontFamily: Platform.select({
											ios: "Menlo",
											android: "monospace"
										})
									}}
								>
									{recoveryKey}
								</Text>
							</View>
							<View className="bg-transparent flex-col gap-3">
								<Button
									onPress={async () => {
										await copyToClipboard(
											recoveryKey,
											t("copied_to_clipboard"),
											"settings",
											"copy recovery key to clipboard failed"
										)
									}}
								>
									{t("copy")}
								</Button>
								<Button
									onPress={async () => {
										const exportResult = await run(async () => {
											return writeTmpFile(`recovery-key.${Date.now()}.txt`, recoveryKey)
										})

										if (!exportResult.success) {
											logger.error("settings", "recovery key file write failed", { error: exportResult.error })
											alerts.error(exportResult.error)

											return
										}

										const shareResult = await shareTmpFile({
											uri: exportResult.data.file.uri,
											name: exportResult.data.file.name,
											cleanup: exportResult.data.cleanup
										})

										if (!shareResult.success) {
											logger.warn("settings", "recovery key file share failed", { error: shareResult.error })
											alerts.error(shareResult.error)

											return
										}
									}}
								>
									{t("share")}
								</Button>
								<Button onPress={goBackIfPossible}>
									{t("two_factor_recovery_key_saved_confirm")}
								</Button>
							</View>
						</View>
					</SettingsScrollView>
				)}
			</ScreenBody>
		</Fragment>
	)
}

export default TwoFactorRecoveryKey
