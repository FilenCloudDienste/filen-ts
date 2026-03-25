import "@/global.css"

import { useEffect, memo } from "react"
import * as NavigationBar from "expo-navigation-bar"
import { Platform } from "react-native"
import { ThemeProvider, DefaultTheme } from "@react-navigation/native"
import { useUniwind } from "uniwind"

const StyleProvider = memo(({ children }: { children: React.ReactNode }) => {
	const { theme } = useUniwind()

	useEffect(() => {
		if (Platform.OS === "android") {
			NavigationBar.setStyle(theme === "dark" ? "dark" : "light")
		}
	}, [theme])

	return (
		<ThemeProvider
			value={{
				...DefaultTheme,
				dark: theme === "dark",
				colors: {
					...DefaultTheme.colors,
					background: "transparent"
				}
			}}
		>
			{children}
		</ThemeProvider>
	)
})

export default StyleProvider
