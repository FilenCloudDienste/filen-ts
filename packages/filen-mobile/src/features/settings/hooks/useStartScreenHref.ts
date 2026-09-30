import type { Href } from "expo-router"
import { useStringifiedClient } from "@/lib/auth"
import { useStartScreen, buildStartScreenHref } from "@/features/settings/startScreen"

// Kept out of startScreen.ts so the pure href builder doesn't pull in lib/auth.
export function useStartScreenHref(): Href {
	const stringifiedClient = useStringifiedClient()
	const [startScreen] = useStartScreen()

	return buildStartScreenHref(startScreen, stringifiedClient?.rootUuid ?? "root")
}
