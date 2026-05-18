import { Redirect } from "expo-router"
import { useIsAuthed, useStringifiedClient } from "@/lib/auth"
import { useStartScreen, buildStartScreenHref } from "@/lib/startScreen"

export default function Index() {
	const isAuthed = useIsAuthed()
	const stringifiedClient = useStringifiedClient()
	const [startScreen] = useStartScreen()

	if (!isAuthed) {
		return <Redirect href="/auth/login" />
	}

	return <Redirect href={buildStartScreenHref(startScreen, stringifiedClient?.rootUuid ?? "root")} />
}
