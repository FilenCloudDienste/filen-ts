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
			{/* hidden must be EXPLICIT here: SystemBars' entries-stack merge skips undefined, so
			  * without a false base entry, popping any transient hidden:true entry (the gallery's
			  * immersive landscape video mode) would leave the bars hidden forever. */}
			<SystemBars
				style={theme === "dark" ? "light" : "dark"}
				hidden={{
					statusBar: false,
					navigationBar: false
				}}
			/>
			{children}
		</ThemeProvider>
	)
}

export default StyleProvider
