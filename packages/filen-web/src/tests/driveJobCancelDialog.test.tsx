// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import "@/lib/i18n"

const { cancelTransfer, resumeTransfer } = vi.hoisted(() => ({ cancelTransfer: vi.fn(), resumeTransfer: vi.fn() }))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { cancelTransfer, resumeTransfer } }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), custom: vi.fn(), dismiss: vi.fn() } }))

import { DriveJobCancelDialog } from "@/features/transfers/components/driveJobCancelDialog"
import { createCopyJob } from "@/features/drive/lib/copy.logic"
import { getDriveJob, useDriveJobsStore } from "@/features/transfers/store/useDriveJobsStore"
import type { DriveJob } from "@/features/drive/lib/driveJobs.logic"
import { compressJob, extractJob } from "@/tests/support/archiveJobFixtures"

function seed(job: DriveJob): void {
	useDriveJobsStore.setState({ jobs: { job }, cancelPromptId: null, passwordPromptId: null, reportJobId: null })
}

beforeEach(() => {
	seed(createCopyJob("job", { uuid: null, name: "Photos" }, 2))
})

afterEach(() => {
	cleanup()
})

function ask(): void {
	act(() => {
		useDriveJobsStore.getState().setCancelPromptId("job")
	})
}

describe("DriveJobCancelDialog for a copy", () => {
	it("stays closed until a stop is asked for", () => {
		render(<DriveJobCancelDialog />)

		expect(screen.queryByRole("alertdialog")).toBeNull()
	})

	it("offers continuing, trashing and keeping, with keeping focused", async () => {
		render(<DriveJobCancelDialog />)
		ask()

		const dialog = await screen.findByRole("alertdialog")

		expect(dialog.textContent).toContain("Items already copied to Photos can stay there or move to the trash.")
		expect(screen.getByRole("button", { name: "Continue copying" })).toBeTruthy()
		expect(screen.getByRole("button", { name: "Move copied items to trash" })).toBeTruthy()
		expect(document.activeElement).toBe(screen.getByRole("button", { name: "Stop and keep copied items" }))
	})

	it("stops and keeps what was copied", async () => {
		render(<DriveJobCancelDialog />)
		ask()
		fireEvent.click(await screen.findByRole("button", { name: "Stop and keep copied items" }))

		expect(cancelTransfer).toHaveBeenCalledWith("job")
		expect(getDriveJob("job")?.cancelRequest).toBe("keep")
		expect(useDriveJobsStore.getState().cancelPromptId).toBeNull()
	})

	it("stops and moves what was copied to the trash", async () => {
		render(<DriveJobCancelDialog />)
		ask()
		fireEvent.click(await screen.findByRole("button", { name: "Move copied items to trash" }))

		expect(cancelTransfer).toHaveBeenCalledWith("job")
		expect(getDriveJob("job")?.cancelRequest).toBe("trash")
	})

	it("continuing stops nothing", async () => {
		render(<DriveJobCancelDialog />)
		ask()
		fireEvent.click(await screen.findByRole("button", { name: "Continue copying" }))

		expect(cancelTransfer).not.toHaveBeenCalled()
		expect(getDriveJob("job")?.cancelRequest).toBeNull()
		expect(useDriveJobsStore.getState().cancelPromptId).toBeNull()
	})

	it("never opens for a copy that already ended", () => {
		useDriveJobsStore.getState().update("copy", "job", job => ({ ...job, outcome: { status: "done" } }))
		render(<DriveJobCancelDialog />)
		ask()

		expect(screen.queryByRole("alertdialog")).toBeNull()
	})
})

describe("DriveJobCancelDialog for an extract", () => {
	it("offers continuing, trashing and keeping, with keeping focused", async () => {
		seed(extractJob({ phase: "extracting" }))
		render(<DriveJobCancelDialog />)
		ask()

		const dialog = await screen.findByRole("alertdialog")

		expect(dialog.textContent).toContain("Stop extracting?")
		expect(dialog.textContent).toContain("Items already extracted to Photos can stay there or move to the trash.")
		expect(screen.getByRole("button", { name: "Continue extracting" })).toBeTruthy()
		expect(document.activeElement).toBe(screen.getByRole("button", { name: "Stop and keep extracted items" }))

		fireEvent.click(screen.getByRole("button", { name: "Stop and move extracted items to trash" }))

		expect(cancelTransfer).toHaveBeenCalledWith("job")
		expect(getDriveJob("job")?.cancelRequest).toBe("trash")
	})

	it("only keeps once the archive is being removed", async () => {
		seed(extractJob({ phase: "disposingSources", dispose: "trash" }))
		render(<DriveJobCancelDialog />)
		ask()

		const dialog = await screen.findByRole("alertdialog")

		expect(dialog.textContent).toContain(
			"Everything is already extracted to Photos and the archive is being removed. Stopping now keeps the extracted items, and the archive if it is not gone yet."
		)
		expect(screen.getAllByRole("button")).toHaveLength(2)
		expect(screen.queryByRole("button", { name: "Stop and move extracted items to trash" })).toBeNull()

		fireEvent.click(screen.getByRole("button", { name: "Stop and keep extracted items" }))

		expect(getDriveJob("job")?.cancelRequest).toBe("keep")
	})

	it("closes once the job ends, and stays closed for a rerun under the same id", async () => {
		seed(extractJob({ phase: "extracting" }))
		render(<DriveJobCancelDialog />)
		ask()
		await screen.findByRole("alertdialog")

		act(() => {
			useDriveJobsStore.getState().update("extract", "job", job => ({ ...job, outcome: { status: "passwordRequired" } }))
		})

		await waitFor(() => {
			expect(useDriveJobsStore.getState().cancelPromptId).toBeNull()
		})
		expect(screen.queryByRole("alertdialog")).toBeNull()

		act(() => {
			useDriveJobsStore.getState().put(extractJob({ phase: "extracting" }))
		})

		expect(screen.queryByRole("alertdialog")).toBeNull()
	})

	it("keeps its own words through the exit animation after a stop, even once the job is gone", async () => {
		// An exit animation that never ends holds the closing dialog on screen.
		const never = new Promise<never>(() => undefined)

		Object.defineProperty(Element.prototype, "getAnimations", {
			configurable: true,
			value: () => [{ finished: never, pending: false, playState: "running" }]
		})

		try {
			seed(extractJob({ phase: "extracting" }))
			render(<DriveJobCancelDialog />)
			ask()
			fireEvent.click(await screen.findByRole("button", { name: "Stop and keep extracted items" }))

			act(() => {
				useDriveJobsStore.getState().remove("job")
			})

			expect(screen.getByText("Stop extracting?")).toBeTruthy()
			expect(screen.queryByText("Stop copying?")).toBeNull()
		} finally {
			Reflect.deleteProperty(Element.prototype, "getAnimations")
		}
	})
})

describe("DriveJobCancelDialog for a compress", () => {
	it("offers continuing and stopping only, saying nothing is left behind", async () => {
		seed(compressJob({ phase: "compressing" }))
		render(<DriveJobCancelDialog />)
		ask()

		const dialog = await screen.findByRole("alertdialog")

		expect(dialog.textContent).toContain("Stop compressing?")
		expect(dialog.textContent).toContain("Stopping leaves nothing behind.")
		expect(screen.getAllByRole("button")).toHaveLength(2)
		expect(document.activeElement).toBe(screen.getByRole("button", { name: "Stop compressing" }))

		fireEvent.click(screen.getByRole("button", { name: "Stop compressing" }))

		expect(cancelTransfer).toHaveBeenCalledWith("job")
		expect(getDriveJob("job")?.cancelRequest).toBe("keep")
	})

	it("says the archive is already saved once it is being checked", async () => {
		seed(compressJob({ phase: "verifying" }))
		render(<DriveJobCancelDialog />)
		ask()

		const dialog = await screen.findByRole("alertdialog")

		expect(dialog.textContent).toContain("The archive is already saved in Photos. Stopping now keeps the originals not yet removed.")
	})

	it("closes once the job ends", async () => {
		seed(compressJob({ phase: "compressing" }))
		render(<DriveJobCancelDialog />)
		ask()
		await screen.findByRole("alertdialog")

		act(() => {
			useDriveJobsStore.getState().update("compress", "job", job => ({ ...job, outcome: { status: "done" } }))
		})

		expect(screen.queryByRole("alertdialog")).toBeNull()
	})
})
