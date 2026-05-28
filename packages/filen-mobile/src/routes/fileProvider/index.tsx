import SafeAreaView from "@/components/ui/safeAreaView"
import { Group } from "@/routes/tabs/more"
import { GestureHandlerScrollView } from "@/components/ui/view"
import { Fragment, memo } from "react"
import { router } from "expo-router"
import { run } from "@filen/utils"
import { useResolveClassNames } from "uniwind"
import Header from "@/components/ui/header"
import { Platform } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import prompts from "@/lib/prompts"
import alerts from "@/lib/alerts"
import { useSecureStore } from "@/lib/secureStore"
import fileProvider, { FILE_PROVIDER_ENABLED_SECURE_STORE_KEY } from "@/lib/fileProvider"
import { type Biometric } from "@/routes/security/biometric"
import Text from "@/components/ui/text"

const FILE_PROVIDER_FEATURE_LABEL = Platform.OS === "ios" ? "tbd_file_provider" : "tbd_documents_provider"
const FILE_PROVIDER_FEATURE_DESCRIPTION = Platform.OS === "ios" ? "tbd_file_provider_description" : "tbd_documents_provider_description"

const FileProviderSettings = memo(() => {
	const bgBackgroundSecondary = useResolveClassNames("bg-background-secondary")
	const textForeground = useResolveClassNames("text-foreground")
	const insets = useSafeAreaInsets()
	const [enabled, setEnabled] = useSecureStore<boolean>(FILE_PROVIDER_ENABLED_SECURE_STORE_KEY, false)
	const [biometric, setBiometric] = useSecureStore<Biometric>("biometric", {
		enabled: false
	})

	return (
		<Fragment>
			<Header
				title={FILE_PROVIDER_FEATURE_LABEL}
				transparent={Platform.OS === "ios"}
				shadowVisible={false}
				backVisible={Platform.OS === "android"}
				backgroundColor={Platform.select({
					ios: undefined,
					default: bgBackgroundSecondary.backgroundColor as string
				})}
				leftItems={() => {
					if (Platform.OS === "android") {
						return null
					}

					return [
						{
							type: "button",
							icon: {
								name: "close",
								color: textForeground.color,
								size: 20
							},
							props: {
								onPress: () => {
									if (router.canGoBack()) {
										router.back()
									}
								}
							}
						}
					]
				}}
			/>
			<SafeAreaView
				className="flex-1 bg-background-secondary"
				edges={["left", "right"]}
			>
				<GestureHandlerScrollView
					className="bg-transparent flex-1"
					contentInsetAdjustmentBehavior="automatic"
					contentContainerClassName="px-4 gap-2"
					showsHorizontalScrollIndicator={false}
					contentContainerStyle={{
						paddingBottom: insets.bottom
					}}
				>
					<Group
						className="bg-background-tertiary"
						buttons={[
							{
								icon: "folder-open-outline",
								title: FILE_PROVIDER_FEATURE_LABEL,
								rightItem: {
									type: "switch",
									value: enabled,
									onValueChange: async (next: boolean) => {
										if (!next) {
											const result = await run(async () => {
												await fileProvider.disable()
											})

											if (!result.success) {
												console.error(result.error)
												alerts.error(result.error)

												return
											}

											setEnabled(false)

											return
										}

										// Enabling. If biometric is currently on, warn the user that
										// turning the provider on disables biometric (the native
										// extensions read auth.json directly and bypass the JS
										// biometric gate — keeping both on would only create a
										// false sense of security).
										if (biometric.enabled) {
											const confirmResult = await run(async () => {
												return await prompts.alert({
													title: "tbd_file_provider_disables_biometric_title",
													message: "tbd_file_provider_disables_biometric_message",
													okText: "tbd_continue",
													cancelText: "tbd_cancel"
												})
											})

											if (!confirmResult.success) {
												console.error(confirmResult.error)
												alerts.error(confirmResult.error)

												return
											}

											if (confirmResult.data.cancelled) {
												return
											}

											setBiometric({
												enabled: false
											})
										}

										const enableResult = await run(async () => {
											await fileProvider.enable()
										})

										if (!enableResult.success) {
											console.error(enableResult.error)
											alerts.error(enableResult.error)

											return
										}

										setEnabled(true)
									}
								}
							}
						]}
					/>
					<Text className="text-sm text-muted-foreground px-4 leading-5">{FILE_PROVIDER_FEATURE_DESCRIPTION}</Text>
				</GestureHandlerScrollView>
			</SafeAreaView>
		</Fragment>
	)
})

export default FileProviderSettings
