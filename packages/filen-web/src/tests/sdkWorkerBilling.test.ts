import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Remote } from "comlink"
import type { StringifiedClient } from "@filen/sdk-rs"
import type { SdkWorkerApi } from "@/workers/sdk.worker"

// The billing and presence ops are plain pass-throughs to the SDK client; the invoice PDF goes back transferred.

const { exposed, transfer, fakeClient } = vi.hoisted(() => ({
	exposed: new Map<"api", unknown>(),
	transfer: vi.fn((value: unknown, _transferables: unknown[]) => value),
	fakeClient: {
		setAppearOffline: vi.fn<(appearOffline: boolean) => Promise<void>>(),
		createSubscription: vi.fn<(planId: number, method: string) => Promise<string>>(),
		cancelSubscription: vi.fn<(uuid: string) => Promise<void>>(),
		generateInvoice: vi.fn<(uuid: string) => Promise<Uint8Array>>(),
		withdrawSubscription: vi.fn<(uuid: string, name: string, email: string, lang: string) => Promise<bigint>>(),
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
	transfer
}))

await import("@/workers/sdk.worker")

const api = exposed.get("api") as Remote<SdkWorkerApi>

beforeEach(async () => {
	await api.injectClient("session" as unknown as StringifiedClient)
})

describe("billing worker ops", () => {
	it("sets appear offline", async () => {
		fakeClient.setAppearOffline.mockResolvedValue(undefined)

		await api.setAppearOffline(true)

		expect(fakeClient.setAppearOffline).toHaveBeenCalledWith(true)
	})

	it("creates a checkout for a plan id and method and returns its URL", async () => {
		fakeClient.createSubscription.mockResolvedValue("https://checkout.example/session")

		await expect(api.createSubscription(27, "paypal")).resolves.toBe("https://checkout.example/session")
		expect(fakeClient.createSubscription).toHaveBeenCalledWith(27, "paypal")
	})

	it("cancels a subscription by its id", async () => {
		fakeClient.cancelSubscription.mockResolvedValue(undefined)

		await api.cancelSubscription("sub-1")

		expect(fakeClient.cancelSubscription).toHaveBeenCalledWith("sub-1")
	})

	it("hands the invoice PDF back as a transfer of its buffer", async () => {
		const pdf = new Uint8Array([37, 80, 68, 70])

		fakeClient.generateInvoice.mockResolvedValue(pdf)

		await expect(api.generateInvoice("inv-1")).resolves.toBe(pdf)
		expect(fakeClient.generateInvoice).toHaveBeenCalledWith("inv-1")
		expect(transfer).toHaveBeenCalledWith(pdf, [pdf.buffer])
	})

	it("withdraws with name, email and language and returns when it was received", async () => {
		fakeClient.withdrawSubscription.mockResolvedValue(1_762_000_000_000n)

		await expect(api.withdrawSubscription("sub-1", "Jane Doe", "jane@example.com", "de")).resolves.toBe(1_762_000_000_000n)
		expect(fakeClient.withdrawSubscription).toHaveBeenCalledWith("sub-1", "Jane Doe", "jane@example.com", "de")
	})

	it("passes an SDK refusal through as a rejection", async () => {
		fakeClient.cancelSubscription.mockRejectedValue(new Error("cannot_cancel_sub_now"))

		await expect(api.cancelSubscription("sub-1")).rejects.toBeDefined()
	})
})
