import { beforeEach, describe, expect, it, vi } from "vitest"
import type { DesktopFileProviderState } from "@filen/shared/desktop"

const fileProvider = vi.hoisted(() => ({
	supported: true,
	state: vi.fn(),
	enable: vi.fn(),
	disable: vi.fn(),
	reveal: vi.fn(),
	openSettings: vi.fn()
}))
const toastError = vi.hoisted(() => vi.fn())

vi.mock("@/lib/desktop", () => ({ desktopBridge: () => ({ fileProvider }) }))
vi.mock("sonner", () => ({ toast: { error: toastError } }))

const { refreshFileProvider, revealFileProvider, setFileProviderEnabled, useFileProviderStore } =
	await import("@/features/mounts/lib/fileProviderStore")

const OFF: DesktopFileProviderState = { supported: true, enabled: false, lockBlocked: false, userEnabled: null, translocated: false }
const ON: DesktopFileProviderState = { ...OFF, enabled: true, userEnabled: true }

describe("file provider store", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		useFileProviderStore.setState({ state: null, pending: null, failure: null })
	})

	it("shares a read in flight and keeps an unchanged state's object", async () => {
		fileProvider.state.mockResolvedValue({ ...OFF })

		await Promise.all([refreshFileProvider(), refreshFileProvider()])
		expect(fileProvider.state).toHaveBeenCalledTimes(1)

		const first = useFileProviderStore.getState().state

		await refreshFileProvider()
		expect(useFileProviderStore.getState().state).toBe(first)
	})

	it("applies what a successful switch answers", async () => {
		fileProvider.enable.mockResolvedValue({ ok: true, value: ON })

		const done = setFileProviderEnabled(true)

		expect(useFileProviderStore.getState().pending).toBe("enable")
		await done
		expect(useFileProviderStore.getState()).toMatchObject({ state: ON, pending: null, failure: null })
		expect(fileProvider.state).not.toHaveBeenCalled()
	})

	it("keeps a failed switch's code until the next switch succeeds, and reads the state again", async () => {
		fileProvider.enable.mockResolvedValueOnce({ ok: false, error: { code: "timeout" } })
		fileProvider.state.mockResolvedValue({ ...ON, userEnabled: null })

		await setFileProviderEnabled(true)
		expect(useFileProviderStore.getState().failure).toEqual({ code: "timeout", read: false })
		expect(fileProvider.state).toHaveBeenCalledTimes(1)

		await refreshFileProvider()
		expect(useFileProviderStore.getState().failure).toEqual({ code: "timeout", read: false })

		fileProvider.disable.mockResolvedValue({ ok: true, value: OFF })
		await setFileProviderEnabled(false)
		expect(useFileProviderStore.getState().failure).toBeNull()
	})

	it("counts a rejected bridge call as unknown, and a failed read until a read succeeds", async () => {
		fileProvider.enable.mockRejectedValueOnce(new Error("ipc gone"))
		fileProvider.state.mockRejectedValueOnce(new Error("ipc gone"))

		await setFileProviderEnabled(true)
		expect(useFileProviderStore.getState().failure).toEqual({ code: "unknown", read: false })

		useFileProviderStore.setState({ failure: null })
		fileProvider.state.mockRejectedValueOnce(new Error("ipc gone"))
		await refreshFileProvider()
		expect(useFileProviderStore.getState().failure).toEqual({ code: "unknown", read: true })

		fileProvider.state.mockResolvedValueOnce(OFF)
		await refreshFileProvider()
		expect(useFileProviderStore.getState().failure).toBeNull()
	})

	it("ignores a switch while one is in flight", async () => {
		useFileProviderStore.setState({ pending: "enable" })

		await setFileProviderEnabled(false)
		expect(fileProvider.disable).not.toHaveBeenCalled()
	})

	it("tells a failed reveal as a toast", async () => {
		fileProvider.reveal.mockResolvedValueOnce({ ok: true, value: null })
		await revealFileProvider()
		expect(toastError).not.toHaveBeenCalled()

		fileProvider.reveal.mockResolvedValueOnce({ ok: false, error: { code: "notFound" } })
		await revealFileProvider()
		expect(toastError).toHaveBeenCalledTimes(1)
	})
})
