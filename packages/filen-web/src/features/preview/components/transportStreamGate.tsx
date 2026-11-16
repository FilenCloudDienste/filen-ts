import { useEffect, useState, type ReactNode } from "react"
import { asDirectoryOrFile, driveItemMime, type DriveItem } from "@/features/drive/lib/item"
import { narrowToAnyFile } from "@/features/drive/lib/download"
import { TEXT_MAX_BYTES, unprobedTransportStream } from "@/features/drive/lib/preview.logic"
import { useFileKindVerdict } from "@/features/drive/hooks/useFileKindVerdict"
import { recordContentVerdict } from "@/features/drive/lib/contentVerdicts"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { mediaFailureDTO } from "@/lib/media/mediaFailure"
import { useTranslation } from "react-i18next"
import { driveItemName } from "@filen/shared"
import { usePreviewAccessMode, useProvidedPreviewOrigin } from "@/features/preview/lib/accessMode"
import { probeTransportStream } from "@/features/preview/lib/transportStreamProbe"
import { PreviewDownloadButton, PreviewErrorState, PreviewLoading } from "@/features/preview/components/previewErrorState"

// Holds a `.ts`/`.mts` that may be a transport stream until its probe says which it is; the verdict then
// picks the viewer (previewType), so `render` runs only once it is known. Anything else renders at once,
// an archive's entry included (no file to probe). TypeScript too large to load whole offers Download.
export function TransportStreamGate({ item, render }: { item: DriveItem; render: () => ReactNode }) {
	const { t } = useTranslation("preview")
	const access = usePreviewAccessMode()
	const provided = useProvidedPreviewOrigin()
	const uuid = item.data.uuid
	const verdict = useFileKindVerdict(uuid)
	const waiting = provided === null && verdict === undefined && unprobedTransportStream(item)
	const [failedAttempt, setFailedAttempt] = useState<number | null>(null)
	const [attempt, setAttempt] = useState(0)
	const [file] = useState(() => (asDirectoryOrFile(item).type === "file" ? narrowToAnyFile(item) : null))
	const name = driveItemName(item)
	const mime = driveItemMime(item)
	const size = item.data.size

	useEffect(() => {
		if (!waiting || file === null) {
			return
		}

		const abort = new AbortController()

		void probeTransportStream(file, access, abort.signal).then(isStream => {
			if (abort.signal.aborted) {
				return
			}

			if (isStream === null) {
				setFailedAttempt(attempt)
			} else {
				// A public link's verdict stays in memory: an anonymous visit leaves nothing in kv.
				recordContentVerdict({ uuid, name, mime, size }, isStream ? "transportStream" : "notTransportStream", {
					memoryOnly: access !== "authed"
				})
			}
		})

		return () => {
			abort.abort()
		}
	}, [waiting, file, uuid, name, mime, size, access, attempt])

	if (!waiting) {
		return verdict === "notTransportStream" && asDirectoryOrFile(item).data.size > TEXT_MAX_BYTES ? (
			<PreviewErrorState
				message={t("previewTextTooLarge")}
				action={<PreviewDownloadButton />}
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
