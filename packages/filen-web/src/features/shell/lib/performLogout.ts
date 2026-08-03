import { runLogout } from "@/lib/logout"
import { sync as notesSync } from "@/features/notes/lib/sync"
import { sync as chatsSync } from "@/features/chats/lib/sync"
import { clearAllTyping } from "@/features/chats/lib/typing"
import { socketBridge } from "@/lib/sdk/socket"
import { sdkApi } from "@/lib/sdk/client"
import { wipeSwClient } from "@/features/drive/lib/saveDownload"
import { clearSession, broadcastAuth } from "@/lib/sdk/session"
import { kvClear } from "@/lib/storage/adapter"
import { disposeAudioEngine } from "@/features/audio/lib/audioEngine"
import { confirmDiscardUnsavedPreview, usePreviewUnsavedGuardStore } from "@/features/preview/store/usePreviewUnsavedGuard"
import { queryClient } from "@/queries/client"
import { toast } from "sonner"
import { i18n } from "@/lib/i18n"

// Resolves once no unsaved preview buffer is left — the overlay dropping its dirty bit (discard, close,
// unmount). Immediate when nothing is dirty.
function awaitPreviewBufferReleased(): Promise<void> {
	if (!usePreviewUnsavedGuardStore.getState().dirty) {
		return Promise.resolve()
	}

	return new Promise(resolve => {
		const unsubscribe = usePreviewUnsavedGuardStore.subscribe(state => {
			if (!state.dirty) {
				unsubscribe()
				resolve()
			}
		})
	})
}

export interface PerformLogoutOptions {
	// The server has already revoked this session (a password change on another device). The
	// unsaved-preview prompt may then only DELAY the wipe — one chance to copy the text out — never veto
	// it: declining defers the teardown until the buffer is released instead of cancelling it, so a
	// server-dead session can't keep decrypted local state alive indefinitely.
	forced?: boolean
}

// The single unified sign-out both surfaces drive through: the account menu (user-initiated) and the
// realtime socket's password-changed force-logout — one teardown path, mirroring mobile's lone
// auth.logout(). @/lib/logout stays free of any worker-constructing import so its own node test can
// import it (see runLogout's own note); the real collaborators are wired here instead, at the component
// layer, and injected into runLogout's phased wipe. Resolves `false` — with nothing torn down — only
// when a NON-forced sign-out was declined at the unsaved-preview prompt below.
export async function performLogout(options?: PerformLogoutOptions): Promise<boolean> {
	// A dirty preview buffer lives only in memory: the wipe + reload below destroys it with no recovery,
	// so the user answers BEFORE anything is torn down. Cancel leaves a user-initiated sign-out's session
	// completely intact — nothing has run at this point.
	if (!(await confirmDiscardUnsavedPreview())) {
		if (options?.forced !== true) {
			return false
		}

		// Says what the generic prompt cannot: the sign-out is not cancelled, only waiting. Persistent —
		// it stays until the wipe's own reload takes the page.
		toast.warning(i18n.t("auth:logoutForcedPending"), { duration: Infinity })

		await awaitPreviewBufferReleased()
	}

	// Notes + chats sync cancel BEFORE the wipe: abort each outbox loop and suppress any further disk
	// write so a late flush can never resurrect this account's plaintext queue after kv-clear lands.
	notesSync.cancel()
	chatsSync.cancel()
	// Stop every typing watchdog + wipe the typing store so no timer fires into the cleared session.
	clearAllTyping()
	// Stop playback, revoke the live blob URL, tear down the media element and clear the queue so no
	// audio from this account survives into the next session.
	disposeAudioEngine()
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

	return true
}
