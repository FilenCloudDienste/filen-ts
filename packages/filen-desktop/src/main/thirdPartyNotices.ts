import { readFile } from "node:fs/promises"
import path from "node:path"
import { type } from "arktype"
import { CHANNELS } from "../shared/channels.ts"
import { checkedCalls, type IpcMain, registerCalls } from "./pages.ts"

// The third-party notices of what the shell adds to the web build (scripts/generateThirdPartyNotices.ts), which
// build.ts copies beside main.js. Read only when the page's notices dialog asks, never kept: the dialog is rarely
// opened and the file is hundreds of KB.
export const THIRD_PARTY_NOTICES_FILE = "thirdPartyNotices.json"

export interface ThirdPartyNoticesSource {
	// The file as JSON text; the preload parses it.
	read(): Promise<string>
}

export function fileThirdPartyNotices(dir: string): ThirdPartyNoticesSource {
	return { read: () => readFile(path.join(dir, THIRD_PARTY_NOTICES_FILE), "utf8") }
}

const call = checkedCalls<ThirdPartyNoticesSource>("third-party notices")

const CALLS: Record<"thirdPartyNotices", ReturnType<typeof call>> = {
	thirdPartyNotices: call(type([]), source => source.read())
}

// Answers the app's own top-level document only, with no arguments accepted.
export function registerThirdPartyNoticesIpc(
	ipc: IpcMain,
	source: ThirdPartyNoticesSource,
	trusted: (senderUrl: string | undefined) => boolean
): void {
	registerCalls(ipc, CALLS, name => CHANNELS[name], source, trusted)
}
