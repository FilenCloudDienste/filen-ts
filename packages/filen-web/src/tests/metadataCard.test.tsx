// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { MetadataCard } from "@/features/preview/components/metadataCard"
import type { MetadataField, MetadataSectionData, MetadataTableData } from "@/features/preview/lib/metadataCard.types"
import { mockViewportHeight } from "@/tests/support/viewport"
import "@/lib/i18n"

const { copyText } = vi.hoisted(() => ({ copyText: vi.fn(() => Promise.resolve(true)) }))

vi.mock("@/lib/copyText", () => ({ copyText }))

const INFOHASH: MetadataField = { label: "Infohash", value: "c9e15763f722f23e98a29decdfae341b98d53056", mono: true, copy: "c9e15763" }
const SECTIONS: readonly MetadataSectionData[] = [
	{ fields: [INFOHASH, { label: "Pieces", value: "1,204" }] },
	{
		title: "Trackers",
		fields: [
			{ label: "Tracker", value: "udp://a.example" },
			{ label: "Tracker", value: "udp://b.example" }
		]
	}
]
const TABLE: MetadataTableData = {
	label: "Files",
	columns: [
		{ key: "path", label: "Path" },
		{ key: "size", label: "Size", align: "end" }
	],
	rows: Array.from({ length: 1000 }, (_, index) => [`dir/file-${String(index)}.bin`, `${String(index)} KB`])
}

function renderCard(props: Partial<Parameters<typeof MetadataCard>[0]>) {
	return render(
		<TooltipProvider>
			<MetadataCard
				title="ubuntu.torrent"
				sections={SECTIONS}
				{...props}
			/>
		</TooltipProvider>
	)
}

afterEach(() => {
	cleanup()
	copyText.mockClear()
})

describe("MetadataCard data", () => {
	it("survives a structured clone unchanged, so workers post it as is", () => {
		expect(structuredClone(INFOHASH)).toEqual(INFOHASH)
		expect(structuredClone(SECTIONS)).toEqual(SECTIONS)
		expect(structuredClone(TABLE)).toEqual(TABLE)
	})
})

describe("MetadataCard", () => {
	it("shows the title, subtitle, sections and footer", () => {
		renderCard({ subtitle: "BitTorrent v1", footer: "Trackers are never contacted." })

		expect(screen.getByText("ubuntu.torrent")).toBeTruthy()
		expect(screen.getByText("BitTorrent v1")).toBeTruthy()
		expect(screen.getByText("Trackers")).toBeTruthy()
		expect(screen.getAllByText("Tracker")).toHaveLength(2)
		expect(screen.getByText("udp://b.example")).toBeTruthy()
		expect(screen.getByText(INFOHASH.value).className).toContain("font-mono")
		expect(screen.getByText("1,204").className).not.toContain("font-mono")
		expect(screen.getByText("Trackers are never contacted.")).toBeTruthy()
	})

	it("copies a field's copy text, and offers Copy only where one is set", () => {
		renderCard({})

		expect(screen.getAllByRole("button", { name: /^Copy / })).toHaveLength(1)

		fireEvent.click(screen.getByRole("button", { name: "Copy Infohash" }))

		expect(copyText).toHaveBeenCalledWith("c9e15763", "Copied")
	})

	it("draws a value through renderValue, and the default where it returns undefined", () => {
		renderCard({
			renderValue: field =>
				field.label === "Pieces" ? (
					<a
						href="#pieces"
						data-testid="custom"
					>
						{field.value}
					</a>
				) : undefined
		})

		expect(screen.getByTestId("custom").textContent).toBe("1,204")
		expect(screen.getByText(INFOHASH.value).tagName).toBe("SPAN")
		expect(screen.getAllByRole("button", { name: /^Copy / })).toHaveLength(1)
	})

	it("mounts only the table rows in view", () => {
		mockViewportHeight(element => element.getAttribute("role") === "rowgroup", 320)
		renderCard({ table: TABLE })

		const table = screen.getByRole("table", { name: "Files" })
		const rows = within(table).getAllByRole("row")

		expect(table.getAttribute("aria-rowcount")).toBe("1001")
		expect(rows.length).toBeGreaterThan(2)
		expect(rows.length).toBeLessThan(40)
		expect(within(table).getByText("dir/file-0.bin")).toBeTruthy()
		expect(within(table).queryByText("dir/file-999.bin")).toBeNull()
		expect(within(table).getByText("0 KB").className).toContain("text-end")
	})

	it("lets the keyboard reach the table's scroller", () => {
		renderCard({ table: TABLE })

		expect(within(screen.getByRole("table", { name: "Files" })).getByRole("rowgroup").tabIndex).toBe(0)
	})
})
