// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import type { File, UuidStr } from "@filen/sdk-rs"
import "@/lib/i18n"
import type { TorrentReading } from "@/features/preview/lib/textFamilyClient"

// A torrent's metadata as the worker reads it: infohashes and magnet to copy, pieces and facts, trackers as text (never
// contacted), files in a table; an unreadable file gets the unsupported card.

const { reading } = vi.hoisted(() => ({ reading: { current: null as TorrentReading | null } }))

vi.mock("@/features/preview/hooks/usePreviewBytes", () => ({
	usePreviewBytes: () => ({ status: "success", bytes: new Uint8Array(4), refetch: vi.fn() })
}))
vi.mock("@/features/preview/lib/textFamilyClient", () => ({
	readTorrentFile: () => (reading.current === null ? Promise.reject(new Error("gone")) : Promise.resolve(reading.current))
}))

const { TorrentViewer } = await import("@/features/preview/components/torrentViewer")
const { narrowItem } = await import("@/features/drive/lib/item")
const { PreviewDownloadableProvider } = await import("@/features/preview/lib/accessMode")

afterEach(() => {
	cleanup()
	reading.current = null
})

const ITEM = narrowItem({
	uuid: "file-0000-0000-0000-000000000000",
	stableUUID: undefined,
	parent: "parent-0000-0000-0000-000000000000" as UuidStr,
	size: 4n,
	favorited: false,
	region: "de-1",
	bucket: "filen-1",
	timestamp: 0n,
	chunks: 1n,
	canMakeThumbnail: false,
	meta: {
		type: "decoded",
		data: { name: "album.torrent", mime: "application/x-bittorrent", modified: 0n, size: 4n, key: "k", version: 2 }
	}
} satisfies File)

function mount(): void {
	render(
		<PreviewDownloadableProvider
			downloadable
			onDownload={vi.fn()}
		>
			<TorrentViewer item={ITEM} />
		</PreviewDownloadableProvider>
	)
}

const V1 = "a".repeat(40)

describe("TorrentViewer", () => {
	it("shows the identifiers, facts, trackers and files", async () => {
		reading.current = {
			status: "ok",
			info: {
				name: "Album",
				version: 1,
				private: true,
				pieceLength: 262144n,
				pieceCount: 2,
				files: [
					{ path: "Album/01.flac", size: 1000n },
					{ path: "Album/cover.jpg", size: 2000n }
				],
				filesOmitted: 0,
				totalSize: 3000n,
				trackers: ["udp://tracker.example:1337/announce"],
				webSeeds: [],
				comment: "Live",
				createdBy: "qBittorrent",
				creationDate: 1_700_000_000,
				infoSpan: [0, 1]
			},
			hashes: { v1: V1, v2: null },
			magnet: `magnet:?xt=urn:btih:${V1}&dn=Album`
		}

		mount()

		expect(await screen.findByText("Album")).toBeTruthy()
		expect(screen.getByText(/BitTorrent v1 · 2 files/)).toBeTruthy()
		expect(screen.getByText(V1)).toBeTruthy()
		expect(screen.getByRole("button", { name: "Copy Infohash v1" })).toBeTruthy()
		expect(screen.getByRole("button", { name: "Copy Magnet link" })).toBeTruthy()
		expect(screen.getByText("udp://tracker.example:1337/announce")).toBeTruthy()
		expect(screen.getByText("Read from the file only: no tracker or peer was contacted.")).toBeTruthy()
		expect(screen.getByText("Yes")).toBeTruthy()
	})

	it("says when the file is no torrent it can read, or one past its caps", async () => {
		reading.current = { status: "malformed" }

		mount()

		expect(await screen.findByText("This torrent file can't be read.")).toBeTruthy()

		cleanup()
		reading.current = { status: "tooLarge" }

		mount()

		expect(await screen.findByText("This torrent is too large to show here.")).toBeTruthy()
	})
})
