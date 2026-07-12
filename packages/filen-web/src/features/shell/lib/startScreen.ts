import { type, type Type } from "arktype"
import { kvGetJson, kvSetJson } from "@/lib/storage/adapter"

// Which top-level module the app redirects to once boot resolves an authed session (routes/index.tsx).
// Mirrors mobile's Appearance → "Start screen" picker (Drive/Photos/Notes/Chats/More), narrowed to the
// four module routes this app's icon rail actually has today — there is no Photos module yet, and
// Settings/Transfers are utility surfaces nobody would want to land on by default.
export const START_SCREENS = ["drive", "notes", "chats", "contacts"] as const

export type StartScreen = (typeof START_SCREENS)[number]

export const DEFAULT_START_SCREEN: StartScreen = "drive"

const START_SCREEN_KV_KEY = "shell.startScreen.v1"

const startScreenSchema: Type<StartScreen> = type.enumerated(...START_SCREENS)

// kvGetJson collapses "absent" and "schema-invalid" to null (see @/lib/storage/adapter); the `??`
// default is the self-heal, same rule as every other kv-backed preference in this app.
export async function getStartScreen(): Promise<StartScreen> {
	return (await kvGetJson(START_SCREEN_KV_KEY, startScreenSchema)) ?? DEFAULT_START_SCREEN
}

export async function setStartScreen(next: StartScreen): Promise<void> {
	await kvSetJson(START_SCREEN_KV_KEY, next)
}
