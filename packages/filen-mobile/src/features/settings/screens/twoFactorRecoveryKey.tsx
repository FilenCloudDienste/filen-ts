import SafeAreaView from "@/components/ui/safeAreaView"
import View from "@/components/ui/view"
import Text from "@/components/ui/text"
import Button from "@/components/ui/button"
import ListEmpty from "@/components/ui/listEmpty"
import { SettingsScrollView } from "@/components/ui/settingsScrollView"
import { Fragment } from "react"
import { Platform } from "react-native"
import { useLocalSearchParams } from "expo-router"
import { router } from "@/lib/router"
import { run } from "@filen/utils"
import SettingsHeader from "@/components/ui/settingsHeader"
import * as Clipboard from "expo-clipboard"
import { useTranslation } from "react-i18next"
import alerts from "@/lib/alerts"
import { shareTmpFile } from "@/lib/share"
import { newTmpFile } from "@/lib/tmp"
import logger from "@/lib/logger"

function TwoFactorRecoveryKey() {
	const { t } = useTranslation()
	const { recoveryKey } = useLocalSearchParams<{ recoveryKey?: string }>()

	return (
		<Fragment>
			<SettingsHeader
				title={t("two_factor_recovery_key")}
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
				{!recoveryKey || recoveryKey.length === 0 ? (
					<ListEmpty
						icon="warning-outline"
						title={t("two_factor_recovery_key_unavailable")}
						description={t("two_factor_recovery_key_unavailable_description")}
					/>
				) : (
					<SettingsScrollView>
						<View className="bg-transparent flex-col gap-6 px-4 pt-4">
							<Text className="text-foreground-secondary text-base leading-6">
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
										const result = await run(async () => {
											return await Clipboard.setStringAsync(recoveryKey)
										})

										if (!result.success) {
											logger.warn("settings", "copy recovery key to clipboard failed", { error: result.error instanceof Error ? result.error.message : String(result.error) })
											alerts.error(result.error)

											return
										}

										alerts.normal(t("copied_to_clipboard"))
									}}
								>
									{t("copy")}
								</Button>
								<Button
									onPress={async () => {
										const exportResult = await run(async () => {
											const file = newTmpFile(`recovery-key.${Date.now()}.txt`)

											if (file.exists) {
												file.delete()
											}

											file.write(recoveryKey)

											return file
										})

										if (!exportResult.success) {
											logger.error("settings", "recovery key file write failed", { error: exportResult.error instanceof Error ? exportResult.error.message : String(exportResult.error) })
											alerts.error(exportResult.error)

											return
										}

										const shareResult = await shareTmpFile({
											uri: exportResult.data.uri,
											name: exportResult.data.name,
											cleanup: () => {
												if (exportResult.data.exists) {
													exportResult.data.delete()
												}
											}
										})

										if (!shareResult.success) {
											logger.warn("settings", "recovery key file share failed", { error: shareResult.error instanceof Error ? shareResult.error.message : String(shareResult.error) })
											alerts.error(shareResult.error)

											return
										}
									}}
								>
									{t("share")}
								</Button>
								<Button
									onPress={() => {
										if (router.canGoBack()) {
											router.back()
										}
									}}
								>
									{t("two_factor_recovery_key_saved_confirm")}
								</Button>
							</View>
						</View>
					</SettingsScrollView>
				)}
			</SafeAreaView>
		</Fragment>
	)
}

export default TwoFactorRecoveryKey
