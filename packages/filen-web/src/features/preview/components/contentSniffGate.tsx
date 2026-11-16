import { useEffect, useEffectEvent, useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { driveItemName, SNIFF_VERDICTS, type FileVerdict } from "@filen/shared"
import { driveItemMime, type DriveItem } from "@/features/drive/lib/item"
import { bufferedSizeCap, CATEGORY_POLICY, needsContentSniff, previewType } from "@/features/drive/lib/preview.logic"
import { useFileKindVerdict } from "@/features/drive/hooks/useFileKindVerdict"
import { recordContentVerdict } from "@/features/drive/lib/contentVerdicts"
import { deviceProfile } from "@/lib/deviceProfile"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { mediaFailureDTO } from "@/lib/media/mediaFailure"
import { usePreviewAccessMode, usePreviewCacheScope, usePreviewOrigin } from "@/features/preview/lib/accessMode"
import { gateRunsSniffer, SNIFFERS } from "@/features/preview/lib/contentSniff.logic"
import { runContentSniff } from "@/features/preview/lib/contentSniff"
import { PreviewErrorState, PreviewLoading, PreviewUnsupportedState } from "@/features/preview/components/previewErrorState"

// A read this gate ran found a text kind too large to load whole (a `.ts` that is TypeScript after all).
function sniffedTooLarge(item: DriveItem, verdict: FileVerdict | undefined): boolean {
	const id = verdict === undefined ? null : needsContentSniff(item, null)

	if (verdict === undefined || id === null || SNIFFERS[id].mode === "viewer" || !SNIFF_VERDICTS[id].includes(verdict)) {
		return false
	}

	const category = previewType(item, verdict)
	const cap = bufferedSizeCap(category, deviceProfile())

	return CATEGORY_POLICY[category].textFamily && cap !== null && item.data.size > cap
}

// Holds a file whose viewer its content read picks (needsContentSniff) until that read has run: here for a probe or a
// head read (a `.ts`/`.mts` that may be a transport stream), in the viewer itself for a viewer-mode one. The verdict
// then picks the viewer (previewType), so `render` runs only once it is known. A file opened as text, and an origin
// the read cannot reach (an archive's entry, for a probe), render at once.
export function ContentSniffGate({ item, asText, render }: { item: DriveItem; asText: boolean; render: () => ReactNode }) {
	const { t } = useTranslation("preview")
	const access = usePreviewAccessMode()
	const scope = usePreviewCacheScope()
	const origin = usePreviewOrigin(item)
	const uuid = item.data.uuid
	const verdict = useFileKindVerdict(uuid)
	// The file whose read ran here: a verdict that changes nothing is not kept (verdictChangesKind), and must not start
	// the read again.
	const [sniffedUuid, setSniffedUuid] = useState<string | null>(null)
	const sniff = asText || sniffedUuid === uuid ? null : needsContentSniff(item, verdict ?? null)
	const waiting = sniff !== null && gateRunsSniffer(SNIFFERS[sniff], origin.kind)
	const [failedAttempt, setFailedAttempt] = useState<number | null>(null)
	const [attempt, setAttempt] = useState(0)
	const name = driveItemName(item)
	const mime = driveItemMime(item)
	const size = item.data.size
	// The origin and cache scope as they stand: usePreviewOrigin builds a new origin each render.
	const readFrom = useEffectEvent(() => ({ origin, scope, access }))

	useEffect(() => {
		if (sniff === null || !waiting) {
			return
		}

		const abort = new AbortController()
		const from = readFrom()

		void runContentSniff(sniff, from.origin, crypto.randomUUID(), {
			access: from.access,
			scope: from.scope,
			signal: abort.signal
		}).then(
			found => {
				if (!abort.signal.aborted) {
					// A public link's verdict stays in memory: an anonymous visit leaves nothing in kv.
					recordContentVerdict({ uuid, name, mime, size }, found, { memoryOnly: access !== "authed" })
					setSniffedUuid(uuid)
				}
			},
			() => {
				if (!abort.signal.aborted) {
					setFailedAttempt(attempt)
				}
			}
		)

		return () => {
			abort.abort()
		}
	}, [waiting, sniff, uuid, name, mime, size, access, attempt])

	if (!waiting) {
		return sniffedTooLarge(item, verdict) ? (
			<PreviewUnsupportedState
				item={item}
				message={t("previewTextTooLarge")}
			/>
		) : (
			render()
		)
	}

	if (failedAttempt === attempt) {
		return (
			<PreviewErrorState
				message={errorLabel(mediaFailureDTO("other"))}
				onRetry={() => {
					setAttempt(previous => previous + 1)
				}}
			/>
		)
	}

	return <PreviewLoading />
}
