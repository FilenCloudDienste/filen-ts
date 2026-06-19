import { Platform, Share } from "react-native"
import * as Sharing from "expo-sharing"
import { run } from "@filen/utils"
import { withSystemPresentation } from "@/lib/systemPresentation"

/**
 * Shares a freshly-written temporary file through the OS share sheet, then runs the
 * caller-supplied cleanup. Deduplicated from the master-keys / 2FA-recovery / GDPR /
 * single-note / bulk-note / drive-file export flows, which all wrote a temp file and
 * shared it with the same flush-delay + delete-after-share dance.
 *
 * The brief delay guarantees the file is fully flushed to disk before the share sheet
 * reads it. `cleanup` is deferred so it always runs — whether the share succeeds, fails
 * or the user cancels. Silent: returns the run() Result so the calling screen owns the
 * error UX (logging / alerts).
 */
export async function shareTmpFile({
	uri,
	name,
	mimeType = "text/plain",
	cleanup
}: {
	uri: string
	name: string
	mimeType?: string
	cleanup: () => void
}) {
	return await run(async defer => {
		defer(cleanup)

		// Small delay to ensure file is fully written before sharing
		await new Promise<void>(resolve => setTimeout(resolve, 100))

		// The OS share sheet resigns the app active (the user hasn't left), so funnel it through the
		// presentation coordinator like the pickers — keeps the privacy cover hidden and skips a re-lock.
		await withSystemPresentation(() =>
			Sharing.shareAsync(uri, {
				mimeType,
				dialogTitle: name
			})
		)
	})
}

/**
 * Shares a URL / link through the OS share sheet.
 *
 * Unlike shareTmpFile (which shares a local FILE via expo-sharing), links must go through React
 * Native's core Share API: expo-sharing is file-only — its Android module (SharingModule.kt) rejects
 * any non-`file://` scheme, so Sharing.shareAsync(httpsUrl) throws on Android. Share.share routes the
 * link via ACTION_SEND text/plain (Android) / UIActivityViewController (iOS). Android ignores the
 * `url` field, so the link goes in `message`; iOS uses `url` for the richer link share.
 *
 * Wrapped in withSystemPresentation like shareTmpFile — the share sheet resigns the app active, so
 * this keeps the privacy cover hidden and skips a biometric re-lock. Silent: rejects on failure for
 * the calling screen to surface (logging / alerts).
 */
export async function shareUrl(url: string): Promise<void> {
	await withSystemPresentation(() => Share.share(Platform.OS === "ios" ? { url } : { message: url }))
}
