import { describe, expect, it, vi } from "vitest"
import type { DesktopMountsOverview, DesktopServe } from "@filen/shared/desktop"

const mounts = vi.hoisted(() => ({ onOverview: vi.fn(), overview: vi.fn(), confirmSignOut: vi.fn() }))

vi.mock("@/lib/desktop", () => ({ desktopBridge: () => ({ mounts }) }))

const { confirmMountsSignOut, loadMounts, useMountsStore } = await import("@/features/mounts/lib/mountsStore")

const SERVE: DesktopServe = {
	protocol: "webdav",
	enabled: true,
	state: "running",
	address: "127.0.0.1",
	addressKind: "loopback",
	port: 1900,
	httpsCapable: true,
	https: false,
	readOnly: false,
	authenticated: true,
	url: "http://127.0.0.1:1900",
	tlsFingerprint: null,
	error: null
}

function overview(serves: DesktopServe[], pendingUploads: number): DesktopMountsOverview {
	return {
		host: { state: "running" },
		available: true,
		fuse: { state: "ready", provider: "fuse3" },
		fuseGap: null,
		drive: { enabled: true, state: "running", mountPoint: "/home/a/Filen", driveLetter: null, readOnly: false, error: null },
		serves,
		protocols: ["webdav", "s3"],
		cache: { usedBytes: 10, freeBytes: 20, pendingUploads, erroredFiles: 0 },
		tuning: { cacheMaxGiB: 32, cacheMinFreeGiB: 16, cacheMaxAgeHours: 720, dirCacheSeconds: 15 },
		notices: []
	}
}

describe("mounts store", () => {
	it("follows the overview once and keeps unchanged roles' objects", async () => {
		let push: (next: DesktopMountsOverview) => void = () => undefined

		mounts.onOverview.mockImplementation((callback: (next: DesktopMountsOverview) => void) => {
			push = callback

			return () => undefined
		})
		mounts.overview.mockResolvedValue(overview([], 0))

		loadMounts()
		loadMounts()
		expect(mounts.onOverview).toHaveBeenCalledTimes(1)

		push(overview([SERVE, { ...SERVE, protocol: "s3", port: 1800 }], 1))
		const first = useMountsStore.getState().overview

		push(
			overview(
				[
					{ ...SERVE, state: "stopping" },
					{ ...SERVE, protocol: "s3", port: 1800 }
				],
				2
			)
		)
		const second = useMountsStore.getState().overview

		expect(second?.serves[0]).not.toBe(first?.serves[0])
		expect(second?.serves[1]).toBe(first?.serves[1])
		expect(second?.drive).toBe(first?.drive)
		expect(second?.tuning).toBe(first?.tuning)

		// The initial read does not overwrite a pushed overview.
		await Promise.resolve()
		expect(useMountsStore.getState().overview?.serves).toHaveLength(2)
	})

	it("asks the shell before a sign-out, and goes on when the ask fails", async () => {
		mounts.confirmSignOut.mockResolvedValueOnce(false)
		await expect(confirmMountsSignOut()).resolves.toBe(false)

		mounts.confirmSignOut.mockResolvedValueOnce(true)
		await expect(confirmMountsSignOut()).resolves.toBe(true)

		mounts.confirmSignOut.mockRejectedValueOnce(new Error("ipc gone"))
		await expect(confirmMountsSignOut()).resolves.toBe(true)
	})
})
