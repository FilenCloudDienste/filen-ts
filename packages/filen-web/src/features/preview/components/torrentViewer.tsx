import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import type { TFunction } from "i18next"
import { formatBytes } from "@filen/shared"
import type { DriveItem } from "@/features/drive/lib/item"
import { usePreviewBytes } from "@/features/preview/hooks/usePreviewBytes"
import { readTorrentFile, type TorrentReading } from "@/features/preview/lib/textFamilyClient"
import { MetadataCard } from "@/features/preview/components/metadataCard"
import { PreviewErrorState, PreviewGate, PreviewLoading, PreviewUnsupportedState } from "@/features/preview/components/previewErrorState"
import type { MetadataField, MetadataSectionData, MetadataTableData } from "@/features/preview/lib/metadataCard.types"
import { formatDateTime } from "@/lib/formatDate"

type ReadingState = { status: "pending" } | { status: "done"; reading: TorrentReading } | { status: "failed" }

// The torrent read in the text-family worker.
function useTorrentReading(bytes: Uint8Array): ReadingState {
	const [state, setState] = useState<ReadingState>({ status: "pending" })

	useEffect(() => {
		let live = true

		readTorrentFile(bytes).then(
			reading => {
				if (live) setState({ status: "done", reading })
			},
			() => {
				if (live) setState({ status: "failed" })
			}
		)

		return () => {
			live = false
		}
	}, [bytes])

	return state
}

type Read = Extract<TorrentReading, { status: "ok" }>

function sections(t: TFunction<"preview">, { info, hashes, magnet }: Read): MetadataSectionData[] {
	const identity: MetadataField[] = []

	if (hashes.v1 !== null) {
		identity.push({ label: t("previewTorrentInfohashV1"), value: hashes.v1, mono: true, copy: hashes.v1 })
	}

	if (hashes.v2 !== null) {
		identity.push({ label: t("previewTorrentInfohashV2"), value: hashes.v2, mono: true, copy: hashes.v2 })
	}

	identity.push({ label: t("previewTorrentMagnet"), value: magnet, mono: true, copy: magnet })

	const details: MetadataField[] = [
		{
			label: t("previewTorrentPieces"),
			value:
				info.pieceCount === null
					? formatBytes(Number(info.pieceLength))
					: t("previewTorrentPiecesValue", { count: info.pieceCount, size: formatBytes(Number(info.pieceLength)) })
		},
		{ label: t("previewTorrentPrivate"), value: t(info.private ? "previewTorrentYes" : "previewTorrentNo") }
	]

	if (info.creationDate !== null) {
		details.push({ label: t("previewTorrentCreated"), value: formatDateTime(info.creationDate * 1000) })
	}

	if (info.createdBy !== null) {
		details.push({ label: t("previewTorrentCreatedBy"), value: info.createdBy })
	}

	if (info.comment !== null && info.comment !== "") {
		details.push({ label: t("previewTorrentComment"), value: info.comment })
	}

	const result: MetadataSectionData[] = [{ fields: identity }, { fields: details }]

	if (info.trackers.length > 0) {
		result.push({
			title: t("previewTorrentTrackers"),
			fields: info.trackers.map((tracker, index) => ({ label: String(index + 1), value: tracker, mono: true }))
		})
	}

	if (info.webSeeds.length > 0) {
		result.push({
			title: t("previewTorrentWebSeeds"),
			fields: info.webSeeds.map((seed, index) => ({ label: String(index + 1), value: seed, mono: true }))
		})
	}

	return result
}

function fileTable(t: TFunction<"preview">, { info }: Read): MetadataTableData {
	return {
		label: t("previewTorrentFiles"),
		columns: [
			{ key: "path", label: t("previewTorrentFilePath") },
			{ key: "size", label: t("previewTorrentFileSize"), align: "end" }
		],
		rows: info.files.map(file => [file.path, formatBytes(Number(file.size))])
	}
}

function TorrentView({ item, bytes }: { item: DriveItem; bytes: Uint8Array }) {
	const { t } = useTranslation("preview")
	const state = useTorrentReading(bytes)

	if (state.status === "pending") {
		return <PreviewLoading />
	}

	if (state.status === "failed") {
		return <PreviewErrorState message={t("previewTorrentFailed")} />
	}

	if (state.reading.status === "unreadable") {
		return (
			<PreviewUnsupportedState
				item={item}
				message={t("previewTorrentUnreadable")}
			/>
		)
	}

	const read = state.reading
	const { info } = read
	const version = info.version === "hybrid" ? t("previewTorrentVersionHybrid") : t("previewTorrentVersion", { version: info.version })

	return (
		<div className="size-full overflow-y-auto p-4 sm:p-6">
			<div className="mx-auto max-w-3xl">
				<MetadataCard
					title={info.name === "" ? t("previewTorrentUnnamed") : info.name}
					subtitle={t("previewTorrentSummary", {
						version,
						count: info.files.length + info.filesOmitted,
						size: formatBytes(Number(info.totalSize))
					})}
					sections={sections(t, read)}
					table={fileTable(t, read)}
					footer={
						<>
							{info.filesOmitted > 0 ? `${t("previewTorrentFilesOmitted", { count: info.filesOmitted })} ` : null}
							{t("previewTorrentNotContacted")}
						</>
					}
				/>
			</div>
		</div>
	)
}

// A torrent's metadata: its infohashes and magnet link to copy, its pieces and facts, its trackers (text: never
// contacted) and its files.
export function TorrentViewer({ item }: { item: DriveItem }) {
	const result = usePreviewBytes(item)

	return (
		<PreviewGate result={result}>
			{ready => (
				<TorrentView
					item={item}
					bytes={ready.bytes}
				/>
			)}
		</PreviewGate>
	)
}
