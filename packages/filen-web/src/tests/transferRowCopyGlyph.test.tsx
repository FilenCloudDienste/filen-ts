// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import "@/lib/i18n"
import { transfers } from "@/locales/en/transfers"

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), custom: vi.fn(), dismiss: vi.fn() } }))

import { TransferRow } from "@/features/transfers/components/transferRow"
import { createCopyJob, type CopyJobGlyph } from "@/features/drive/lib/copy.logic"
import { narrowItem } from "@/features/drive/lib/item"
import { ARCHIVE_ITEM, compressJob, extractJob } from "@/tests/support/archiveJobFixtures"
import { useDriveJobsStore } from "@/features/transfers/store/useDriveJobsStore"
import type { Transfer } from "@/features/transfers/store/useTransfersStore"

function copyRow(name: string): Transfer {
	return {
		id: "job",
		direction: "copy",
		name,
		size: 10,
		bytesTransferred: 10,
		status: "done",
		paused: false,
		parentUuid: null,
		startedAt: 0
	}
}

function renderRow(name: string, glyph: CopyJobGlyph | null): HTMLElement {
	useDriveJobsStore.setState({
		jobs: glyph === null ? {} : { job: createCopyJob("job", { uuid: null, name: "Cloud Drive" }, 1, glyph) },
		cancelPromptId: null
	})

	const { container } = render(
		<TransferRow
			transfer={copyRow(name)}
			onRequestCancel={vi.fn()}
			onShowInDirectory={vi.fn()}
		/>
	)

	return container
}

beforeEach(() => {
	useDriveJobsStore.setState({ jobs: {}, cancelPromptId: null })
})

afterEach(() => {
	cleanup()
})

describe("TransferRow — copy glyph", () => {
	it("shows a directory for a copied directory, whatever its name looks like", () => {
		const row = renderRow("photos.2024", "directory")

		expect(row.querySelector("img")).toBeNull()
		expect(row.querySelector(".lucide-files")).toBeNull()
		expect(row.querySelector('path[d^="M1197,212.6"]')).not.toBeNull()
	})

	it("shows a stack of files for a copy of several items", () => {
		const row = renderRow("3 items", "items")

		expect(row.querySelector(".lucide-files")).not.toBeNull()
		expect(row.querySelector("img")).toBeNull()
	})

	it("shows the file's type icon for a copied file, and falls back to it without a job", () => {
		expect(renderRow("report.pdf", "file").querySelector("img")).not.toBeNull()
		cleanup()
		expect(renderRow("report.pdf", null).querySelector("img")).not.toBeNull()
	})
})

describe("TransferRow — a stopped copy moving its copies to the trash", () => {
	const copied = narrowItem({
		uuid: "d-0000-0000-0000-000000000000",
		parent: "p-0000-0000-0000-000000000000",
		color: "default",
		timestamp: 0n,
		favorited: false,
		meta: { type: "decoded", data: { name: "d" } }
	})

	it("says so in place of its percentage and offers no pause or cancel, which a trash can't take", () => {
		useDriveJobsStore.setState({
			jobs: {
				job: {
					...createCopyJob("job", { uuid: null, name: "Cloud Drive" }, 1),
					outcome: { status: "cancelled" },
					cancelRequest: "trash",
					created: [copied]
				}
			},
			cancelPromptId: null
		})

		render(
			<TransferRow
				transfer={{ ...copyRow("3 items"), status: "copying", bytesTransferred: 4 }}
				onRequestCancel={vi.fn()}
				onShowInDirectory={vi.fn()}
			/>
		)

		expect(screen.getByText("Moving to trash…")).toBeTruthy()
		expect(screen.queryByText("40%")).toBeNull()
		expect(screen.queryByRole("button", { name: "Pause" })).toBeNull()
		expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull()
	})

	// An item delivered after the job ended can reach the trash before the rest, and record its result.
	it("keeps saying so until the row settles, whatever the job has recorded meanwhile", () => {
		useDriveJobsStore.setState({
			jobs: {
				job: {
					...createCopyJob("job", { uuid: null, name: "Cloud Drive" }, 1),
					outcome: { status: "cancelled" },
					cancelRequest: "trash",
					created: [copied],
					trashResult: { moved: 1, failed: 0 }
				}
			},
			cancelPromptId: null
		})

		render(
			<TransferRow
				transfer={{ ...copyRow("3 items"), status: "copying", bytesTransferred: 4 }}
				onRequestCancel={vi.fn()}
				onShowInDirectory={vi.fn()}
			/>
		)

		expect(screen.getByText("Moving to trash…")).toBeTruthy()
		expect(screen.queryByRole("button", { name: "Pause" })).toBeNull()
		expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull()
	})
})

function archiveRow(direction: "compress" | "extract", overrides: Partial<Transfer> = {}): Transfer {
	return {
		...copyRow(direction === "compress" ? "photos.zip" : "photos"),
		direction,
		status: direction === "compress" ? "compressing" : "extracting",
		bytesTransferred: 4,
		...overrides
	}
}

describe("TransferRow — archive jobs", () => {
	it("badges a compress with an archive and an extract with an opened package", () => {
		useDriveJobsStore.setState({ jobs: { job: compressJob({ phase: "compressing" }) } })

		const compress = render(
			<TransferRow
				transfer={archiveRow("compress")}
				onRequestCancel={vi.fn()}
				onShowInDirectory={vi.fn()}
			/>
		).container

		expect(compress.querySelector(".lucide-archive")).not.toBeNull()
		cleanup()

		useDriveJobsStore.setState({ jobs: { job: extractJob({ phase: "extracting" }) } })

		const extract = render(
			<TransferRow
				transfer={archiveRow("extract")}
				onRequestCancel={vi.fn()}
				onShowInDirectory={vi.fn()}
			/>
		).container

		expect(extract.querySelector(".lucide-package-open")).not.toBeNull()
		expect(extract.querySelector('path[d^="M1197,212.6"]')).not.toBeNull()
	})

	it("says it waits for the page's archive slot in place of its figures, and can still be stopped", () => {
		useDriveJobsStore.setState({ jobs: { job: extractJob() } })

		render(
			<TransferRow
				transfer={archiveRow("extract", { size: 100 })}
				onRequestCancel={vi.fn()}
				onShowInDirectory={vi.fn()}
			/>
		)

		expect(screen.getByText(transfers.transfersStatusWaitingForSlot)).toBeTruthy()
		expect(screen.getByRole("progressbar").getAttribute("aria-valuetext")).toBe(transfers.transfersStatusWaitingForSlot)
		expect(screen.queryByText("4%")).toBeNull()
		expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy()
	})

	it("reopens the job's card from any kind's row, named by its kind", () => {
		useDriveJobsStore.setState({ jobs: { job: compressJob() } })

		render(
			<TransferRow
				transfer={archiveRow("compress")}
				onRequestCancel={vi.fn()}
				onShowInDirectory={vi.fn()}
			/>
		)

		expect(screen.getByRole("button", { name: "Show compress progress" })).toBeTruthy()
		cleanup()

		useDriveJobsStore.setState({ jobs: { job: extractJob() } })

		render(
			<TransferRow
				transfer={archiveRow("extract")}
				onRequestCancel={vi.fn()}
				onShowInDirectory={vi.fn()}
			/>
		)

		expect(screen.getByRole("button", { name: "Show extract progress" })).toBeTruthy()
		cleanup()

		useDriveJobsStore.setState({ jobs: { job: createCopyJob("job", { uuid: null, name: "Cloud Drive" }, 1) } })

		render(
			<TransferRow
				transfer={copyRow("photos")}
				onRequestCancel={vi.fn()}
				onShowInDirectory={vi.fn()}
			/>
		)

		expect(screen.getByRole("button", { name: "Show copy progress" })).toBeTruthy()
	})

	it("reveals a compress's archive once it landed", () => {
		const onShowInDirectory = vi.fn()

		useDriveJobsStore.setState({ jobs: { job: compressJob({ outcome: { status: "done" }, archive: ARCHIVE_ITEM }) } })

		render(
			<TransferRow
				transfer={archiveRow("compress", { status: "done" })}
				onRequestCancel={vi.fn()}
				onShowInDirectory={onShowInDirectory}
			/>
		)
		fireEvent.click(screen.getByRole("button", { name: transfers.transfersRowShowInDirectory }))

		expect(onShowInDirectory).toHaveBeenCalledWith(ARCHIVE_ITEM)
	})
})
