import { runLogout } from "@/lib/logout"
import { sync as notesSync } from "@/features/notes/lib/sync"
import { sync as chatsSync } from "@/features/chats/lib/sync"
import { clearAllTyping } from "@/features/chats/lib/typing"
import { socketBridge } from "@/lib/sdk/socket"
import { sdkApi } from "@/lib/sdk/client"
import { wipeSwClient } from "@/features/drive/lib/saveDownload"
import { clearSession, broadcastAuth } from "@/lib/sdk/session"
import { kvClear } from "@/lib/storage/adapter"
import { queryClient } from "@/queries/client"

// The single unified sign-out both surfaces drive through: the account menu (user-initiated) and the
// realtime socket's password-changed force-logout — one teardown path, mirroring mobile's lone
// auth.logout(). @/lib/logout stays free of any worker-constructing import so its own node test can
// import it (see runLogout's own note); the real collaborators are wired here instead, at the component
// layer, and injected into runLogout's phased wipe.
export async function performLogout(): Promise<void> {
	// Notes + chats sync cancel BEFORE the wipe: abort each outbox loop and suppress any further disk
	// write so a late flush can never resurrect this account's plaintext queue after kv-clear lands.
	notesSync.cancel()
	chatsSync.cancel()
	// Stop every typing watchdog + wipe the typing store so no timer fires into the cleared session.
	clearAllTyping()
	// Tear the realtime socket down before the client is released — unsubscribeFromSocket needs the live
	// client. Fire-and-forget: the worker also frees the listener in releaseClient as a backstop.
	void socketBridge.stop()

	await runLogout({
		cancelQueries: () => queryClient.cancelQueries(),
		clearQueryCache: () => {
			queryClient.clear()
		},
		sdkLogout: () => sdkApi.logout(),
		clearSession,
		kvClear,
		wipeServiceWorker: wipeSwClient,
		broadcast: () => {
			broadcastAuth("logout")
		},
		reload: () => {
			location.reload()
		}
	})
}
