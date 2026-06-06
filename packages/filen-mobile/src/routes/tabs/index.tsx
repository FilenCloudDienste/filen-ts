import { Redirect } from "expo-router"
import { useStringifiedClient } from "@/lib/auth"
import { useStartScreen, buildStartScreenHref } from "@/features/settings/startScreen"

export default function Index() {
	const stringifiedClient = useStringifiedClient()
	const [startScreen] = useStartScreen()

	return <Redirect href={buildStartScreenHref(startScreen, stringifiedClient?.rootUuid ?? "root")} />
}
