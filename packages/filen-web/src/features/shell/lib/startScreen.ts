import { type, type Type } from "arktype"
import { kvPreference } from "@/lib/storage/preference"

// Which top-level module the app redirects to once boot resolves an authed session (routes/index.tsx).
// Mirrors mobile's Appearance → "Start screen" picker (Drive/Photos/Notes/Chats/More), narrowed to the
// four module routes this app's icon rail actually has today — there is no Photos module yet, and
// Settings/Transfers are utility surfaces nobody would want to land on by default.
export const START_SCREENS = ["drive", "notes", "chats", "contacts"] as const

export type StartScreen = (typeof START_SCREENS)[number]

export const DEFAULT_START_SCREEN: StartScreen = "drive"

const startScreenSchema: Type<StartScreen> = type.enumerated(...START_SCREENS)

export const { get: getStartScreen, set: setStartScreen } = kvPreference({
	key: "shell.startScreen.v1",
	schema: startScreenSchema,
	fallback: DEFAULT_START_SCREEN
})
