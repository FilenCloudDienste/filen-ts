import { Stack, Redirect } from "expo-router"
import { memo } from "react"
import { useIsAuthed, useStringifiedClient } from "@/lib/auth"
import View from "@/components/ui/view"

const AuthLayout = memo(() => {
	const isAuthed = useIsAuthed()
	const stringifiedClient = useStringifiedClient()

	if (isAuthed) {
		return (
			<Redirect
				href={{
					pathname: "/tabs/drive/[uuid]",
					params: {
						uuid: stringifiedClient?.rootUuid ?? "root"
					}
				}}
			/>
		)
	}

	return (
		<View className="flex-1">
			<Stack />
		</View>
	)
})

export default AuthLayout
