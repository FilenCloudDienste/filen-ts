import { onlineManager } from "@tanstack/react-query"
import { asErrorDTO } from "@/lib/sdk/errors"
import { sdkApi } from "@/lib/sdk/client"
import { readPersistedSession, resumeSession } from "@/lib/sdk/session"
import { setSessionSuspectListener } from "@/lib/sdk/sessionHealth"
import { readSignOutPending } from "@/lib/signOutPending"
import { writeSessionEndedNote } from "@/lib/sessionEndedNote"
import { performLogout } from "@/features/shell/lib/performLogout"
import { log } from "@/lib/log"

// The server answered a call (or the socket) with "API key not valid". Signs out, once, only after confirming it:
// another tab's password change rotates the key this tab holds, and the reply can be a transient one right after a
// change. Never while offline, where no such answer can come.

export interface SessionEndedDeps {
	isOnline: () => boolean
	signOutPending: () => boolean
	// True: the session works. False: no session to check. Rejects with the SDK's error otherwise.
	probe: () => Promise<boolean>
	liveApiKey: () => Promise<string | null>
	persistedApiKey: () => Promise<string | null>
	// Injects the persisted session in place of the live one; false when it could not.
	adoptPersisted: () => Promise<boolean>
	wait: (ms: number) => Promise<void>
	signOut: () => Promise<void>
}

// Between the two probes: long enough for a key the server is still rotating, or another tab's save of it, to land.
export const SESSION_RECHECK_MS = 3_000

type ProbeOutcome = "ok" | "ended" | "unknown"

async function probeOutcome(deps: SessionEndedDeps): Promise<ProbeOutcome> {
	try {
		return (await deps.probe()) ? "ok" : "unknown"
	} catch (e) {
		return asErrorDTO(e).kind === "Unauthenticated" ? "ended" : "unknown"
	}
}

// The live key was rotated (another tab changed the password and saved the new session): take the saved one.
async function adoptRotatedKey(deps: SessionEndedDeps): Promise<boolean> {
	const [persisted, live] = await Promise.all([deps.persistedApiKey(), deps.liveApiKey()])

	if (persisted === null || live === null || persisted === live || !(await deps.adoptPersisted())) {
		return false
	}

	return (await probeOutcome(deps)) !== "ended"
}

export function createSessionEndedCheck(deps: SessionEndedDeps): () => Promise<void> {
	let running = false
	let ended = false

	return async () => {
		if (running || ended || !deps.isOnline() || deps.signOutPending()) {
			return
		}

		running = true

		try {
			for (let round = 0; round < 2; round++) {
				if (round > 0) {
					await deps.wait(SESSION_RECHECK_MS)
				}

				if ((await probeOutcome(deps)) !== "ended" || (await adoptRotatedKey(deps))) {
					return
				}
			}

			// Another tab may have started the sign-out meanwhile, or the network gone.
			if (!deps.isOnline() || deps.signOutPending()) {
				return
			}

			ended = true
			log.warn("session", "the server no longer accepts this session; signing out")
			await deps.signOut()
		} finally {
			running = false
		}
	}
}

async function orNull(read: () => Promise<string | null>): Promise<string | null> {
	try {
		return await read()
	} catch {
		return null
	}
}

const liveDeps: SessionEndedDeps = {
	isOnline: () => onlineManager.isOnline(),
	signOutPending: readSignOutPending,
	probe: () => sdkApi.probeAuthedRead(),
	liveApiKey: () => orNull(async () => (await sdkApi.toStringified()).apiKey),
	persistedApiKey: () => orNull(async () => (await readPersistedSession())?.apiKey ?? null),
	adoptPersisted: async () => {
		try {
			return await resumeSession()
		} catch {
			return false
		}
	},
	wait: ms =>
		new Promise(resolve => {
			setTimeout(resolve, ms)
		}),
	signOut: async () => {
		// Before the sign-out: its reload (and the other tabs' reloads) land on the sign-in screen, which reads it.
		writeSessionEndedNote()
		await performLogout({ forced: true })
	}
}

// Once, at startup. The check runs only on a report.
export function installSessionEndedCheck(): () => void {
	const check = createSessionEndedCheck(liveDeps)

	return setSessionSuspectListener(() => {
		check().catch((e: unknown) => {
			log.error("session", "the session check failed", asErrorDTO(e).label)
		})
	})
}
