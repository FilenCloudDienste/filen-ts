// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import "@/lib/i18n"

const { cancelCopy } = vi.hoisted(() => ({ cancelCopy: vi.fn() }))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { cancelCopy } }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), custom: vi.fn(), dismiss: vi.fn() } }))

import { CopyCancelDialog } from "@/features/transfers/components/copyCancelDialog"
import { createCopyJob } from "@/features/drive/lib/copy.logic"
import { getCopyJob, useCopyJobsStore } from "@/features/transfers/store/useCopyJobsStore"

beforeEach(() => {
	useCopyJobsStore.setState({ jobs: { job: createCopyJob("job", { uuid: null, name: "Photos" }, 2) }, cancelPromptId: null })
})

afterEach(() => {
	cleanup()
})

function ask(): void {
	act(() => {
		useCopyJobsStore.getState().setCancelPromptId("job")
	})
}

describe("CopyCancelDialog", () => {
	it("stays closed until a stop is asked for", () => {
		render(<CopyCancelDialog />)

		expect(screen.queryByRole("alertdialog")).toBeNull()
	})

	it("offers continuing, trashing and keeping, with keeping focused", async () => {
		render(<CopyCancelDialog />)
		ask()

		const dialog = await screen.findByRole("alertdialog")

		expect(dialog.textContent).toContain("Items already copied to Photos can stay there or move to the trash.")
		expect(screen.getByRole("button", { name: "Continue copying" })).toBeTruthy()
		expect(screen.getByRole("button", { name: "Move copied items to trash" })).toBeTruthy()
		expect(document.activeElement).toBe(screen.getByRole("button", { name: "Stop and keep copied items" }))
	})

	it("stops and keeps what was copied", async () => {
		render(<CopyCancelDialog />)
		ask()
		fireEvent.click(await screen.findByRole("button", { name: "Stop and keep copied items" }))

		expect(cancelCopy).toHaveBeenCalledWith("job")
		expect(getCopyJob("job")?.cancelRequest).toBe("keep")
		expect(useCopyJobsStore.getState().cancelPromptId).toBeNull()
	})

	it("stops and moves what was copied to the trash", async () => {
		render(<CopyCancelDialog />)
		ask()
		fireEvent.click(await screen.findByRole("button", { name: "Move copied items to trash" }))

		expect(cancelCopy).toHaveBeenCalledWith("job")
		expect(getCopyJob("job")?.cancelRequest).toBe("trash")
	})

	it("continuing stops nothing", async () => {
		render(<CopyCancelDialog />)
		ask()
		fireEvent.click(await screen.findByRole("button", { name: "Continue copying" }))

		expect(cancelCopy).not.toHaveBeenCalled()
		expect(getCopyJob("job")?.cancelRequest).toBeNull()
		expect(useCopyJobsStore.getState().cancelPromptId).toBeNull()
	})

	it("never opens for a copy that already ended", () => {
		useCopyJobsStore.getState().update("job", job => ({ ...job, outcome: { status: "done" } }))
		render(<CopyCancelDialog />)
		ask()

		expect(screen.queryByRole("alertdialog")).toBeNull()
	})
})
