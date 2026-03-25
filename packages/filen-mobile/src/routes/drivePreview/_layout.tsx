import { Stack } from "expo-router"
import { memo } from "react"

const Layout = memo(() => {
	return (
		<Stack
			screenOptions={{
				headerShown: false,
				contentStyle: {
					backgroundColor: "transparent"
				}
			}}
		/>
	)
})

export default Layout
