import "react-native-reanimated"
import "@/global"
import "@/queries/onlineStatus"

import StyleProvider from "@/providers/style.provider"
import { useState, useEffect, Fragment } from "react"
import { memo, useCallback } from "@/lib/memo"
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
import { enableFreeze } from "react-native-screens"
import Socket from "@/components/socket"
import Pathname from "@/components/pathname"
import { Platform } from "react-native"

enableFreeze(true)

SplashScreen.setOptions({
	duration: 400,
	fade: true
})

SplashScreen.preventAutoHideAsync().catch(console.error)

export const RootLayout = memo(() => {
	const bgBackground = useResolveClassNames("bg-background")
	const [isSetupDone, setIsSetupDone] = useState<boolean>(false)
	const isAuthed = useIsAuthed()

	const runSetup = useCallback(async () => {
		const result = await run(async () => {
			setIsSetupDone(false)

			return await setup.setup()
		})

		if (!result.success) {
			console.error(result.error)

			setIsSetupDone(false)

			return
		}

		console.log("Setup complete, isAuthed:", result.data.isAuthed)

		setIsSetupDone(true)

		setTimeout(() => {
			SplashScreen.hideAsync().catch(console.error)
		}, 1)
	}, [])

	useEffect(() => {
		runSetup()
	}, [runSetup])

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
									<View className="flex-1">
										{isSetupDone && (
											<Fragment>
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
															presentation: Platform.OS === "ios" ? "pageSheet" : "formSheet"
														}}
													/>
													<Stack.Screen
														name="offline"
														options={{
															presentation: Platform.OS === "ios" ? "pageSheet" : "formSheet"
														}}
													/>
													<Stack.Screen
														name="driveItemInfo"
														options={{
															presentation: Platform.OS === "ios" ? "pageSheet" : "formSheet"
														}}
													/>
													<Stack.Screen
														name="changeDirectoryColor"
														options={{
															presentation: Platform.OS === "ios" ? "pageSheet" : "formSheet"
														}}
													/>
													<Stack.Screen
														name="trash"
														options={{
															presentation: Platform.OS === "ios" ? "pageSheet" : "formSheet"
														}}
													/>
													<Stack.Screen
														name="recents"
														options={{
															presentation: Platform.OS === "ios" ? "pageSheet" : "formSheet"
														}}
													/>
													<Stack.Screen
														name="favorites"
														options={{
															presentation: Platform.OS === "ios" ? "pageSheet" : "formSheet"
														}}
													/>
													<Stack.Screen
														name="sharedIn"
														options={{
															presentation: Platform.OS === "ios" ? "pageSheet" : "formSheet"
														}}
													/>
													<Stack.Screen
														name="sharedOut"
														options={{
															presentation: Platform.OS === "ios" ? "pageSheet" : "formSheet"
														}}
													/>
													<Stack.Screen
														name="links"
														options={{
															presentation: Platform.OS === "ios" ? "pageSheet" : "formSheet"
														}}
													/>
												</Stack>
												{isAuthed && (
													<Fragment>
														<Socket />
														<NotesSync />
														<ChatsSync />
													</Fragment>
												)}
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
