import { type } from "arktype"
import { CHANNELS, type SessionRead } from "../shared/channels.ts"
import { errorCode } from "./atomicFile.ts"
import { checkedCalls, type IpcMain, registerCalls } from "./pages.ts"
import type { SessionVault, VaultCipher } from "./sessionVault.ts"

// A file encrypted with the session vault's cipher besides the session itself.
export interface VaultDependent {
	label: string
	// true when it could not be decrypted and was removed.
	discard(cipher: VaultCipher): Promise<boolean>
}

export interface SessionRecoveryDeps {
	vault: Pick<SessionVault, "discardUnreadable">
	cipher: () => Promise<VaultCipher | null>
	// Listed when asked, so files written since launch are found too.
	dependents: () => Promise<VaultDependent[]>
	info: (message: string) => void
	warn: (message: string) => void
}

// Gives up on a session the vault cannot decrypt. A session that decrypts now is kept and answered. Once no session
// is stored, each dependent goes only when it cannot be decrypted either; a dependent that fails is logged and left,
// so the user can still sign in, and a retry finds it again. Never touches the keychain or the server.
export function sessionDiscarder(deps: SessionRecoveryDeps): () => Promise<SessionRead> {
	return async () => {
		const read = await deps.vault.discardUnreadable()

		if (read.status !== "absent") {
			deps.info(`session recovery: kept the session (${read.status})`)

			return read
		}

		const active = await deps.cipher()

		if (active === null) {
			return read
		}

		for (const dependent of await deps.dependents()) {
			try {
				if (await dependent.discard(active)) {
					deps.info(`session recovery: removed the undecryptable ${dependent.label}`)
				}
			} catch (error) {
				deps.warn(`session recovery: ${dependent.label} not checked: ${errorCode(error)}`)
			}
		}

		return read
	}
}

const call = checkedCalls<() => Promise<SessionRead>>("session")

// Answers the app's own top-level document only and takes no arguments.
export function registerSessionRecoveryIpc(
	ipc: IpcMain,
	discard: () => Promise<SessionRead>,
	trusted: (senderUrl: string | undefined) => boolean
): void {
	registerCalls(ipc, { discardUnreadable: call(type([]), run => run()) }, () => CHANNELS.sessionDiscardUnreadable, discard, trusted)
}
