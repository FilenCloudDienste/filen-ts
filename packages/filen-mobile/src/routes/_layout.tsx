import "react-native-reanimated"
import "@/global"
import "@/queries/onlineStatus"

import StyleProvider from "@/providers/style.provider"
import { useState, Fragment, memo } from "react"
import { Stack } from "expo-router"
import { useResolveClassNames } from "uniwind"
import View from "@/components/ui/view"
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
import NotesSync from "@/components/notes/sync"
import ChatsSync from "@/components/chats/sync"
import ActionSheetProvider from "@/providers/actionSheet.provider"
import Socket from "@/components/socket"
import Pathname from "@/components/pathname"
import { Platform } from "react-native"
import useEffectOnce from "@/hooks/useEffectOnce"
import Http from "@/components/http"

SplashScreen.setOptions({
	duration: 400,
	fade: true
})

SplashScreen.preventAutoHideAsync().catch(console.error)

const RootLayout = memo(() => {
	const bgBackground = useResolveClassNames("bg-background")
	const bgBackgroundSecondary = useResolveClassNames("bg-background-secondary")
	const [isSetupDone, setIsSetupDone] = useState<boolean>(false)
	const isAuthed = useIsAuthed()

	const runSetup = async () => {
		const result = await run(async () => {
			setIsSetupDone(false)

			await setup.setup()
		})

		if (!result.success) {
			console.error(result.error)

			setIsSetupDone(false)

			return
		}

		setIsSetupDone(true)

		setTimeout(() => {
			SplashScreen.hideAsync().catch(console.error)
		}, 1)
	}

	useEffectOnce(() => {
		runSetup()
	})

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
								Haptics.selectionAsync().catch(console.error)
							}
						}}
					>
						<NotifierWrapper useRNScreensOverlay={true}>
							<QueryClientProvider client={queryClient}>
								<ActionSheetProvider>
									<View className="flex-1 bg-background">
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
												options={{
													presentation: Platform.OS === "ios" ? "pageSheet" : "formSheet",
													contentStyle: {
														backgroundColor: bgBackgroundSecondary.backgroundColor
													}
												}}
											/>
											<Stack.Screen
												name="offline"
												options={{
													presentation: Platform.OS === "ios" ? "pageSheet" : "formSheet",
													contentStyle: {
														backgroundColor: bgBackgroundSecondary.backgroundColor
													}
												}}
											/>
											<Stack.Screen
												name="driveItemInfo"
												options={{
													presentation: Platform.OS === "ios" ? "pageSheet" : "formSheet",
													contentStyle: {
														backgroundColor: bgBackgroundSecondary.backgroundColor
													}
												}}
											/>
											<Stack.Screen
												name="changeDirectoryColor"
												options={{
													presentation: Platform.OS === "ios" ? "pageSheet" : "formSheet",
													contentStyle: {
														backgroundColor: bgBackgroundSecondary.backgroundColor
													}
												}}
											/>
											<Stack.Screen
												name="trash"
												options={{
													presentation: Platform.OS === "ios" ? "pageSheet" : "formSheet",
													contentStyle: {
														backgroundColor: bgBackgroundSecondary.backgroundColor
													}
												}}
											/>
											<Stack.Screen
												name="recents"
												options={{
													presentation: Platform.OS === "ios" ? "pageSheet" : "formSheet",
													contentStyle: {
														backgroundColor: bgBackgroundSecondary.backgroundColor
													}
												}}
											/>
											<Stack.Screen
												name="favorites"
												options={{
													presentation: Platform.OS === "ios" ? "pageSheet" : "formSheet",
													contentStyle: {
														backgroundColor: bgBackgroundSecondary.backgroundColor
													}
												}}
											/>
											<Stack.Screen
												name="sharedIn"
												options={{
													presentation: Platform.OS === "ios" ? "pageSheet" : "formSheet",
													contentStyle: {
														backgroundColor: bgBackgroundSecondary.backgroundColor
													}
												}}
											/>
											<Stack.Screen
												name="sharedOut"
												options={{
													presentation: Platform.OS === "ios" ? "pageSheet" : "formSheet",
													contentStyle: {
														backgroundColor: bgBackgroundSecondary.backgroundColor
													}
												}}
											/>
											<Stack.Screen
												name="links"
												options={{
													presentation: Platform.OS === "ios" ? "pageSheet" : "formSheet",
													contentStyle: {
														backgroundColor: bgBackgroundSecondary.backgroundColor
													}
												}}
											/>
											<Stack.Screen
												name="driveSelect"
												options={{
													presentation: Platform.OS === "ios" ? "pageSheet" : "formSheet",
													contentStyle: {
														backgroundColor: bgBackgroundSecondary.backgroundColor
													}
												}}
											/>
											<Stack.Screen
												name="contacts"
												options={{
													presentation: Platform.OS === "ios" ? "pageSheet" : "formSheet",
													contentStyle: {
														backgroundColor: bgBackgroundSecondary.backgroundColor
													}
												}}
											/>
											<Stack.Screen
												name="cameraUpload"
												options={{
													presentation: Platform.OS === "ios" ? "pageSheet" : "formSheet",
													contentStyle: {
														backgroundColor: bgBackgroundSecondary.backgroundColor
													}
												}}
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
												<Socket />
												<Http />
												<NotesSync />
												<ChatsSync />
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
})

export default RootLayout
