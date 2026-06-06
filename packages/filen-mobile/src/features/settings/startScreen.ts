import type { Href } from "expo-router"
import { useSecureStore } from "@/lib/secureStore"

export const START_SCREEN_SECURE_STORE_KEY = "appearance.startScreen"

export const START_SCREENS = ["drive", "photos", "notes", "chats", "more"] as const

export type StartScreen = (typeof START_SCREENS)[number]

export const DEFAULT_START_SCREEN: StartScreen = "drive"

export function useStartScreen(): [StartScreen, (next: StartScreen | ((prev: StartScreen) => StartScreen)) => void] {
	return useSecureStore<StartScreen>(START_SCREEN_SECURE_STORE_KEY, DEFAULT_START_SCREEN)
}

// Builds the Href the app should land on after auth or cold start. `rootUuid` is required
// because the drive landing route is a dynamic `[uuid]` segment — the other tabs don't need it.
export function buildStartScreenHref(startScreen: StartScreen, rootUuid: string): Href {
	switch (startScreen) {
		case "photos": {
			return "/tabs/photos"
		}

		case "notes": {
			return "/tabs/notes"
		}

		case "chats": {
			return "/tabs/chats"
		}

		case "more": {
			return "/tabs/more"
		}

		default: {
			return {
				pathname: "/tabs/drive/[uuid]",
				params: {
					uuid: rootUuid
				}
			}
		}
	}
}
