// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render } from "@testing-library/react"
import "@/lib/i18n"

vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), custom: vi.fn(), dismiss: vi.fn() } }))

import { TransferRow } from "@/features/transfers/components/transferRow"
import { createCopyJob, type CopyJobGlyph } from "@/features/drive/lib/copy.logic"
import { useCopyJobsStore } from "@/features/transfers/store/useCopyJobsStore"
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
	useCopyJobsStore.setState({
		jobs: glyph === null ? {} : { job: createCopyJob("job", { uuid: null, name: "Cloud Drive" }, 1, glyph) },
		cancelPromptId: null
	})

	const { container } = render(
		<TransferRow
			transfer={copyRow(name)}
			onRequestCancel={vi.fn()}
		/>
	)

	return container
}

beforeEach(() => {
	useCopyJobsStore.setState({ jobs: {}, cancelPromptId: null })
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
