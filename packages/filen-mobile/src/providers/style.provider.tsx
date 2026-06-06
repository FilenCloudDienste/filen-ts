import "@/global.css"

import { useEffect } from "react"
import * as NavigationBar from "expo-navigation-bar"
import { Platform } from "react-native"
import { ThemeProvider, DefaultTheme } from "expo-router/react-navigation"
import { useUniwind } from "uniwind"

const StyleProvider = ({ children }: { children: React.ReactNode }) => {
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
}

export default StyleProvider
