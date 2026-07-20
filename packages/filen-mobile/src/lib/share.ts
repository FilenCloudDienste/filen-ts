import { AppState, Platform, Share } from "react-native"
import * as Sharing from "expo-sharing"
import { run } from "@filen/utils"
import { withSystemPresentation } from "@/lib/systemPresentation"
import logger from "@/lib/logger"

// How long after returning to the foreground a still-pending shareAsync is considered
// abandoned. Android's chooser runs as a separate activity and can fail to deliver its
// activity result back to the app (issue #77) — expo-sharing's promise then never settles,
// which would leave the presentation coordinator suppressed (privacy cover off, biometric
// re-lock disabled) and the caller's cleanup unreached for the rest of the process. A
// legitimately delivered result lands while the app is still resuming, so a short
// post-active grace is enough to tell the two apart.
export const SHARE_SETTLE_GRACE_MS = 1500

/**
 * shareAsync raced against a foreground-return watchdog so a dropped activity result can
 * never hang the wrapper. Watchdog settles by RESOLVING — the module's own "result
 * received" behavior resolves null too; from the user's point of view the share completed
 * or was dismissed. The native module's stale-request latch is handled separately by the
 * expo-sharing patch; this guard exists so no share can wedge the JS side regardless.
 */
function shareAsyncWithSettleWatchdog(uri: string, options: Sharing.SharingOptions): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		let settled = false
		let graceTimer: ReturnType<typeof setTimeout> | null = null

		// Only ever CALLED asynchronously (timer / AppState / promise callbacks), so the
		// subscription below is always initialized by the time this runs.
		const settle = (complete: () => void) => {
			if (settled) {
				return
			}

			settled = true

			subscription.remove()

			if (graceTimer !== null) {
				clearTimeout(graceTimer)
			}

			complete()
		}

		const subscription = AppState.addEventListener("change", state => {
			if (settled) {
				return
			}

			if (state === "active") {
				// Back in the app: give a real activity result a moment to land, then settle.
				if (graceTimer !== null) {
					clearTimeout(graceTimer)
				}

				graceTimer = setTimeout(() => {
					settle(() => {
						logger.warn("share", "shareAsync did not settle after returning to the app — watchdog settled it", { uri })
						resolve()
					})
				}, SHARE_SETTLE_GRACE_MS)

				return
			}

			// Left the app again (share target opened, or another presentation) — the share
			// is still plausibly in flight; re-arm on the next return to the foreground.
			if (graceTimer !== null) {
				clearTimeout(graceTimer)

				graceTimer = null
			}
		})

		Sharing.shareAsync(uri, options).then(
			() => {
				settle(resolve)
			},
			(e: unknown) => {
				settle(() => reject(e instanceof Error ? e : new Error(String(e))))
			}
		)
	})
}

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
			shareAsyncWithSettleWatchdog(uri, {
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
