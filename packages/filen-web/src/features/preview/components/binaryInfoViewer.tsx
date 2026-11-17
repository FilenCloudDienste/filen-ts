import { useEffect, useEffectEvent, useState } from "react"
import { useTranslation } from "react-i18next"
import { driveItemName } from "@filen/shared"
import type { DriveItem } from "@/features/drive/lib/item"
import { usePreviewAccessMode, usePreviewOrigin } from "@/features/preview/lib/accessMode"
import { openByteReader } from "@/features/preview/lib/origin/byteReader"
import { readBinaryHeaders } from "@/features/preview/lib/textFamilyClient"
import type { BinaryReading } from "@/features/preview/lib/binaryInfo/reading"
import { binaryCard } from "@/features/preview/lib/binaryInfo/card"
import type { BinarySource } from "@/features/preview/lib/binaryInfo/types"
import { MetadataCard } from "@/features/preview/components/metadataCard"
import { PreviewErrorState, PreviewLoading, PreviewUnsupportedState } from "@/features/preview/components/previewErrorState"
import { sdkApi } from "@/lib/sdk/client"
import { log } from "@/lib/log"

type State = { status: "pending" } | { status: "done"; reading: BinaryReading } | { status: "failed" }

// The facts as a card: kind and format, the facts each format has, the signature (not verified), with a reminder that
// nothing ran.
export function BinaryInfoCard({ item, reading }: { item: DriveItem; reading: BinaryReading }) {
	const { t } = useTranslation("preview")

	if (reading.info === null) {
		return (
			<PreviewUnsupportedState
				item={item}
				message={t("previewBinaryUnreadable")}
			/>
		)
	}

	const card = binaryCard(t, reading.info, reading.signer)

	return (
		<div className="size-full overflow-y-auto p-4 sm:p-6">
			<div className="mx-auto max-w-3xl">
				<MetadataCard
					title={driveItemName(item)}
					subtitle={card.subtitle}
					sections={card.sections.filter(section => section.fields.length > 0)}
					footer={t("previewBinaryNeverRun")}
				/>
			</div>
		</div>
	)
}

// An executable or disk image opened from the drive, a link or an archive: its headers read in ranges, a handful of
// small reads (the reader keeps at most four blocks).
export function BinaryInfoViewer({ item }: { item: DriveItem }) {
	const { t } = useTranslation("preview")
	const access = usePreviewAccessMode()
	const origin = usePreviewOrigin(item)
	const [state, setState] = useState<State>({ status: "pending" })
	const uuid = item.data.uuid
	const name = driveItemName(item)
	// The origin as it stands: usePreviewOrigin builds a new one each render.
	const readFrom = useEffectEvent(() => origin)

	useEffect(() => {
		const abort = new AbortController()
		const token = crypto.randomUUID()
		// Left while reading: the downloads under the token stop.
		const stop = (): void => {
			void sdkApi.cancelPreviewDownload(token)
		}

		abort.signal.addEventListener("abort", stop, { once: true })

		void openByteReader(readFrom(), token, { access, blocks: 4 })
			.then(async reader => {
				const reading = await readBinaryHeaders(reader, name, abort.signal).finally(() => {
					reader.close()
					abort.signal.removeEventListener("abort", stop)
				})

				if (!abort.signal.aborted) setState({ status: "done", reading })
			})
			.catch((e: unknown) => {
				if (abort.signal.aborted) return

				log.error("preview", "reading an executable's headers failed", e)
				setState({ status: "failed" })
			})

		return () => {
			abort.abort()
		}
	}, [uuid, name, access])

	if (state.status === "pending") {
		return <PreviewLoading />
	}

	if (state.status === "failed") {
		return <PreviewErrorState message={t("previewBinaryFailed")} />
	}

	return (
		<BinaryInfoCard
			item={item}
			reading={state.reading}
		/>
	)
}

// The text path's binary notice, for a file whose head is an executable (an extensionless ELF or Mach-O): the bytes it
// already holds are read, nothing more.
export function HeldBinaryInfo({ item, bytes }: { item: DriveItem; bytes: Uint8Array }) {
	const { t } = useTranslation("preview")
	const [state, setState] = useState<State>({ status: "pending" })
	const name = driveItemName(item)

	useEffect(() => {
		const abort = new AbortController()
		const source: BinarySource = {
			size: bytes.length,
			read: (offset, length) =>
				Promise.resolve(bytes.subarray(Math.min(offset, bytes.length), Math.min(offset + length, bytes.length)))
		}

		readBinaryHeaders(source, name, abort.signal).then(
			reading => {
				if (!abort.signal.aborted) setState({ status: "done", reading })
			},
			(e: unknown) => {
				// Closed while reading: no failure to report.
				if (abort.signal.aborted) return

				log.error("preview", "reading an executable's headers failed", e)
				setState({ status: "failed" })
			}
		)

		return () => {
			abort.abort()
		}
	}, [bytes, name])

	if (state.status === "pending") {
		return <PreviewLoading />
	}

	if (state.status === "failed") {
		return <PreviewErrorState message={t("previewBinaryFailed")} />
	}

	return (
		<BinaryInfoCard
			item={item}
			reading={state.reading}
		/>
	)
}
