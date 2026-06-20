import "react-native-reanimated"
import "@/queries/onlineStatus"

import StyleProvider from "@/providers/style.provider"
import { useState, Fragment } from "react"
import { Stack } from "expo-router"
import { useResolveClassNames } from "uniwind"
import View from "@/components/ui/view"
import Text from "@/components/ui/text"
import Button from "@/components/ui/button"
import { t } from "@/lib/i18n"
import setup from "@/lib/setup"
import { run } from "@filen/utils"
import { useIsAuthed } from "@/lib/auth"
import { queryClient } from "@/queries/client"
import { QueryClientProvider } from "@tanstack/react-query"
import * as SplashScreen from "expo-splash-screen"
import { NotifierWrapper } from "react-native-notifier"
import { GestureHandlerRootView } from "react-native-gesture-handler"
import { KeyboardProvider } from "react-native-keyboard-controller"
import { PressablesConfig } from "pressto"
import * as Haptics from "expo-haptics"
import FullScreenLoadingModal from "@/components/ui/fullScreenLoadingModal"
import NotesSync from "@/features/notes/components/sync"
import ChatsSync from "@/features/chats/components/sync"
import ActionSheetProvider from "@/providers/actionSheet.provider"
import Socket from "@/components/shell/socket"
import Pathname from "@/components/pathname"
import { Platform } from "react-native"
import useEffectOnce from "@/hooks/useEffectOnce"
import Http from "@/components/http"
import CameraUploadSync from "@/features/cameraUpload/sync"
import OfflineSync from "@/features/offline/sync"
import IncomingShareHandler from "@/features/incomingShare/incomingShareHandler"
import FloatingBar from "@/components/floatingBar"
import ForegroundService from "@/features/transfers/components/foregroundService"
import Biometric from "@/components/biometric"
import PrivacyScreen from "@/components/privacyScreen"
import AccountReminders from "@/components/accountReminders"
import logger from "@/lib/logger"

SplashScreen.setOptions({
	duration: 400,
	fade: true
})

SplashScreen.preventAutoHideAsync().catch(e => logger.warn("layout", "SplashScreen.preventAutoHideAsync failed", { error: e }))

const RootLayout = () => {
	const bgBackground = useResolveClassNames("bg-background")
	const bgBackgroundSecondary = useResolveClassNames("bg-background-secondary")
	const [isSetupDone, setIsSetupDone] = useState<boolean>(false)
	const [setupFailed, setSetupFailed] = useState<boolean>(false)
	const isAuthed = useIsAuthed()

	const modalOptions = {
		presentation: Platform.OS === "ios" ? "pageSheet" : "modal",
		animation: "slide_from_bottom",
		contentStyle: {
			backgroundColor: bgBackgroundSecondary.backgroundColor
		}
	} satisfies React.ComponentProps<typeof Stack.Screen>["options"]

	const runSetup = async () => {
		const result = await run(async () => {
			setIsSetupDone(false)
			setSetupFailed(false)

			await setup.setup()
		})

		if (!result.success) {
			logger.error("layout", "Setup pipeline failed", { error: result.error })

			setIsSetupDone(false)
			// Surface the failure with a retry path instead of rendering null forever.
			// The native splash MUST be hidden here too — otherwise it stays frozen on top
			// of the error UI, leaving the app permanently stuck behind the splash.
			setSetupFailed(true)

			SplashScreen.hideAsync().catch(e => logger.warn("layout", "SplashScreen.hideAsync failed after setup error", { error: e }))

			return
		}

		setSetupFailed(false)
		setIsSetupDone(true)

		setTimeout(() => {
			SplashScreen.hideAsync().catch(e => logger.warn("layout", "SplashScreen.hideAsync failed after setup", { error: e }))
		}, 1)
	}

	useEffectOnce(() => {
		runSetup()
	})

	if (setupFailed) {
		return (
			<View
				className="flex-1 items-center justify-center gap-4 bg-background p-8"
				style={{
					backgroundColor: bgBackground.backgroundColor
				}}
			>
				<Text className="text-center text-lg font-semibold leading-6">{t("setup_failed_title")}</Text>
				<Text className="text-center text-base text-muted-foreground leading-5">{t("setup_failed_description")}</Text>
				<Button onPress={runSetup}>{t("try_again")}</Button>
			</View>
		)
	}

	if (!isSetupDone) {
		return null
	}

	return (
		<StyleProvider>
			<KeyboardProvider>
				<GestureHandlerRootView
					style={{
						flex: 1,
						backgroundColor: bgBackground.backgroundColor
					}}
				>
					<PressablesConfig
						globalHandlers={{
							onPress: () => {
								Haptics.selectionAsync().catch(e => logger.warn("layout", "Haptics.selectionAsync failed", { error: e }))
							}
						}}
					>
						<NotifierWrapper useRNScreensOverlay={true}>
							<QueryClientProvider client={queryClient}>
								<ActionSheetProvider>
									<View className="flex-1 bg-background">
										{/* App-switcher/background privacy cover (app-wide React FullWindowOverlay — see PrivacyScreen). */}
										<PrivacyScreen />
										{isAuthed && (
											<Fragment>
												<Biometric />
												<AccountReminders />
											</Fragment>
										)}
										<Stack
											initialRouteName={isAuthed ? "tabs" : "auth"}
											screenOptions={{
												headerShown: false,
												contentStyle: {
													backgroundColor: bgBackground.backgroundColor
												}
											}}
										>
											<Stack.Screen
												name="transfers"
												options={modalOptions}
											/>
											<Stack.Screen
												name="offline"
												options={modalOptions}
											/>
											<Stack.Screen
												name="driveItemInfo"
												options={modalOptions}
											/>
											<Stack.Screen
												name="changeDirectoryColor"
												options={modalOptions}
											/>
											<Stack.Screen
												name="trash"
												options={modalOptions}
											/>
											<Stack.Screen
												name="recents"
												options={modalOptions}
											/>
											<Stack.Screen
												name="favorites"
												options={modalOptions}
											/>
											<Stack.Screen
												name="sharedIn"
												options={modalOptions}
											/>
											<Stack.Screen
												name="sharedOut"
												options={modalOptions}
											/>
											<Stack.Screen
												name="links"
												options={modalOptions}
											/>
											<Stack.Screen
												name="driveSelect"
												options={modalOptions}
											/>
											<Stack.Screen
												name="contacts"
												options={modalOptions}
											/>
											<Stack.Screen
												name="register"
												options={modalOptions}
											/>
											<Stack.Screen
												name="cameraUpload"
												options={modalOptions}
											/>
											<Stack.Screen
												name="fileVersions"
												options={modalOptions}
											/>
											<Stack.Screen
												name="noteHistory"
												options={modalOptions}
											/>
											<Stack.Screen
												name="noteParticipants"
												options={modalOptions}
											/>
											<Stack.Screen
												name="chatParticipants"
												options={modalOptions}
											/>
											<Stack.Screen
												name="noteTags"
												options={modalOptions}
											/>
											<Stack.Screen
												name="cameraUploadErrors"
												options={modalOptions}
											/>
											<Stack.Screen
												name="incomingShare"
												options={modalOptions}
											/>
											<Stack.Screen
												name="publicLink"
												options={modalOptions}
											/>
											<Stack.Screen
												name="linkedDir"
												options={modalOptions}
											/>
											<Stack.Screen
												name="linkedFile"
												options={modalOptions}
											/>
											<Stack.Screen
												name="playlists"
												options={modalOptions}
											/>
											<Stack.Screen
												name="selectPlaylists"
												options={modalOptions}
											/>
											<Stack.Screen
												name="account"
												options={modalOptions}
											/>
											<Stack.Screen
												name="security"
												options={modalOptions}
											/>
											<Stack.Screen
												name="fileProvider"
												options={modalOptions}
											/>
											<Stack.Screen
												name="offlineSettings"
												options={modalOptions}
											/>
											<Stack.Screen
												name="offlineSyncErrors"
												options={modalOptions}
											/>
											<Stack.Screen
												name="advanced"
												options={modalOptions}
											/>
											<Stack.Screen
												name="appearance"
												options={modalOptions}
											/>
											<Stack.Screen
												name="events"
												options={modalOptions}
											/>
											<Stack.Screen
												name="eventInfo"
												options={modalOptions}
											/>
											<Stack.Screen
												name="logViewer"
												options={modalOptions}
											/>
											<Stack.Screen
												name="developer"
												options={modalOptions}
											/>
											<Stack.Screen
												name="drivePreview"
												options={{
													presentation: "transparentModal",
													animation: "slide_from_bottom",
													contentStyle: {
														backgroundColor: "transparent"
													}
												}}
											/>
										</Stack>
										{isAuthed && (
											<Fragment>
												<FloatingBar />
												<Socket />
												<Http />
												<NotesSync />
												<ChatsSync />
												<CameraUploadSync />
												<OfflineSync />
												<IncomingShareHandler />
												<ForegroundService />
											</Fragment>
										)}
										<Pathname />
										<FullScreenLoadingModal />
									</View>
								</ActionSheetProvider>
							</QueryClientProvider>
						</NotifierWrapper>
					</PressablesConfig>
				</GestureHandlerRootView>
			</KeyboardProvider>
		</StyleProvider>
	)
}

export default RootLayout
