// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { File, UuidStr } from "@filen/sdk-rs"
import "@/lib/i18n"
import { narrowItem } from "@/features/drive/lib/item"
import { registerAllActions } from "@/lib/keymap/actions"
import { createTestQueryClient, queryClientWrapper } from "@/tests/testQueryClient"
import { readSubtitleText, type SubtitleReading } from "@/features/preview/lib/subtitleCues.logic"

// A subtitle file opens on its cue table (read in the worker from the text the page decoded), with a filter and its
// source a toggle away; past the table's cap it opens as text.

const SRT = "1\n00:00:01,200 --> 00:00:03,900\nHello there.\n\n2\n00:00:04,000 --> 00:01:05,000\nGeneral Kenobi.\n"
const { asked } = vi.hoisted(() => ({ asked: { current: [] as [string, string][], fail: false } }))

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: () => Promise.resolve(null),
	kvSetJson: () => Promise.resolve(),
	kvDelete: () => Promise.resolve()
}))
vi.mock("@/features/preview/hooks/usePreviewBytes", () => ({
	usePreviewBytes: () => ({ status: "success", bytes: new TextEncoder().encode(SRT), refetch: vi.fn() })
}))
vi.mock("@/features/preview/lib/textFamilyClient", () => ({
	readSubtitleCues: (text: string, extension: string): Promise<SubtitleReading> => {
		asked.current.push([text, extension])

		return asked.fail ? Promise.reject(new Error("gone")) : Promise.resolve(readSubtitleText(text, extension))
	}
}))

const { SubtitleViewer } = await import("@/features/preview/components/subtitleViewer")

registerAllActions()

afterEach(() => {
	cleanup()
	asked.current = []
	asked.fail = false
})

function itemNamed(name: string, size: bigint) {
	return narrowItem({
		uuid: "file-0000-0000-0000-000000000000",
		stableUUID: undefined,
		parent: "parent-0000-0000-0000-000000000000" as UuidStr,
		size,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 0n,
		chunks: 1n,
		canMakeThumbnail: false,
		meta: { type: "decoded", data: { name, mime: "application/x-subrip", modified: 0n, size, key: "k", version: 2 } }
	} satisfies File)
}

function mount(name: string, size: bigint): void {
	render(
		<SubtitleViewer
			item={itemNamed(name, size)}
			alt={name}
		/>,
		{ wrapper: queryClientWrapper(createTestQueryClient()) }
	)
}

describe("SubtitleViewer", () => {
	it("shows the cue table with its summary, filters it, and keeps the source a toggle away", async () => {
		mount("movie.srt", 100n)

		expect(await screen.findByText("SRT · 2 cues · UTF-8 · 00:01:05")).toBeTruthy()
		expect(asked.current).toEqual([[SRT, "srt"]])
		expect(screen.getByRole("table", { name: "Cues" }).getAttribute("aria-rowcount")).toBe("3")
		expect(screen.getByRole("button", { name: "Cues" }).getAttribute("aria-pressed")).toBe("true")

		fireEvent.change(screen.getByRole("searchbox", { name: "Find in cues" }), { target: { value: "KENOBI" } })

		expect(screen.getByText("SRT · 2 cues · UTF-8 · 00:01:05 · 1 match")).toBeTruthy()
		expect(screen.getByRole("table", { name: "Cues" }).getAttribute("aria-rowcount")).toBe("2")

		fireEvent.click(screen.getByRole("button", { name: "Source" }))

		expect(await screen.findByText("Hello there.")).toBeTruthy()
	})

	it("says when no cues could be read, or the read failed", async () => {
		mount("movie.sub", 100n)

		expect(await screen.findByText("No cues could be read from this file. Switch to Source to see its text.")).toBeTruthy()

		cleanup()
		asked.fail = true
		mount("movie.srt", 100n)

		expect(await screen.findByText("The cues could not be read.")).toBeTruthy()
	})

	it("opens a file past the table's cap as text, without reading cues", async () => {
		mount("movie.srt", 8n * 1024n * 1024n + 1n)

		expect(await screen.findByText("Hello there.")).toBeTruthy()
		expect(screen.queryByRole("table", { name: "Cues" })).toBeNull()
		expect(asked.current).toEqual([])
	})
})
