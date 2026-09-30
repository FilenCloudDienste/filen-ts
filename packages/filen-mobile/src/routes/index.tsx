import { Redirect } from "expo-router"
import { useIsAuthed } from "@/lib/auth"
import { useStartScreenHref } from "@/features/settings/hooks/useStartScreenHref"

export default function Index() {
	const isAuthed = useIsAuthed()
	const startScreenHref = useStartScreenHref()

	if (!isAuthed) {
		return null
	}

	return <Redirect href={startScreenHref} />
}
