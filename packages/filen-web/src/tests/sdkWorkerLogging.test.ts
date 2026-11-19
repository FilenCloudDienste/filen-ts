import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Remote } from "comlink"
import type { StringifiedClient } from "@filen/sdk-rs"
import type { SdkWorkerApi } from "@/workers/sdk.worker"
import { log } from "@/lib/log"

// The Comlink proxy logs a rejected call by its method name, except a cancel: the caller stopped it on purpose.

const { exposed, fakeClient } = vi.hoisted(() => ({
	exposed: new Map<"api", unknown>(),
	fakeClient: {
		root: () => ({ uuid: "root" }),
		releaseLocks: vi.fn<(locks: unknown) => Promise<void>>(),
		free: vi.fn()
	}
}))

vi.mock("@filen/sdk-rs", () => ({
	default: vi.fn(),
	initThreadPool: vi.fn(),
	UnauthClient: { from_config: () => ({ free: vi.fn(), fromStringified: () => fakeClient }) }
}))

vi.mock("comlink", () => ({
	expose: (api: unknown) => {
		exposed.set("api", api)
	},
	proxy: (value: unknown) => value,
	transfer: (value: unknown) => value
}))

await import("@/workers/sdk.worker")

const api = exposed.get("api") as Remote<SdkWorkerApi>

// The shape a live FilenSdkError has (lib/sdk/errors.ts's isSdkError probe).
function sdkError(kind: string): unknown {
	return { kind, message: `${kind} error`, server_message: () => undefined }
}

beforeEach(async () => {
	await api.injectClient("session" as unknown as StringifiedClient)
	fakeClient.releaseLocks.mockReset()
	vi.mocked(log.error).mockClear()
})

describe("sdk worker proxy logging", () => {
	it("does not log a Cancelled rejection as an error, and still rejects with its DTO", async () => {
		fakeClient.releaseLocks.mockRejectedValue(sdkError("Cancelled"))

		await expect(api.releaseLocks([])).rejects.toMatchObject({ species: "sdk", kind: "Cancelled" })
		expect(log.error).not.toHaveBeenCalled()
	})

	it("logs any other rejection under the method's name", async () => {
		fakeClient.releaseLocks.mockRejectedValue(sdkError("Server"))

		await expect(api.releaseLocks([])).rejects.toMatchObject({ kind: "Server" })
		expect(log.error).toHaveBeenCalledWith("sdk.worker", "releaseLocks", expect.anything())
	})

	it("hands out this realm's log ring", async () => {
		await expect(api.dumpLogs()).resolves.toEqual([])
	})
})
