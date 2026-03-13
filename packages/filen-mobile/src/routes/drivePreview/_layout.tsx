import { Stack } from "expo-router"
import { memo } from "@/lib/memo"

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
