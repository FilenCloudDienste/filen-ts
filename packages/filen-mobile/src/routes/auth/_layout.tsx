import { Stack, Redirect } from "expo-router"
import { useIsAuthed } from "@/lib/auth"
import { useStartScreenHref } from "@/features/settings/hooks/useStartScreenHref"
import View from "@/components/ui/view"

const AuthLayout = () => {
	const isAuthed = useIsAuthed()
	const startScreenHref = useStartScreenHref()

	if (isAuthed) {
		return <Redirect href={startScreenHref} />
	}

	return (
		<View className="flex-1">
			<Stack />
		</View>
	)
}

export default AuthLayout
