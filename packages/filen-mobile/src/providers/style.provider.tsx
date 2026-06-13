import "@/global.css"

import { SystemBars } from "react-native-edge-to-edge"
import { ThemeProvider, DefaultTheme } from "expo-router/react-navigation"
import { useUniwind } from "uniwind"

const StyleProvider = ({ children }: { children: React.ReactNode }) => {
	const { theme } = useUniwind()

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
			<SystemBars style={theme === "dark" ? "light" : "dark"} />
			{children}
		</ThemeProvider>
	)
}

export default StyleProvider
