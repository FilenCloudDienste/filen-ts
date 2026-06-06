import { Stack, Redirect } from "expo-router"
import { useIsAuthed, useStringifiedClient } from "@/lib/auth"
import { useStartScreen, buildStartScreenHref } from "@/features/settings/startScreen"
import View from "@/components/ui/view"

const AuthLayout = () => {
	const isAuthed = useIsAuthed()
	const stringifiedClient = useStringifiedClient()
	const [startScreen] = useStartScreen()

	if (isAuthed) {
		return <Redirect href={buildStartScreenHref(startScreen, stringifiedClient?.rootUuid ?? "root")} />
	}

	return (
		<View className="flex-1">
			<Stack />
		</View>
	)
}

export default AuthLayout
