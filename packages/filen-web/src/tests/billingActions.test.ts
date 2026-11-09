import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { onlineManager } from "@tanstack/react-query"
import type { UserAccountSubs, UserInfo } from "@filen/sdk-rs"
import type { ErrorDTO } from "@/lib/sdk/errors"

const { sdk, accountQueryUpdate, fetchAccountFresh, downloadBlob } = vi.hoisted(() => ({
	sdk: {
		setAppearOffline: vi.fn<(enabled: boolean) => Promise<void>>(),
		createSubscription: vi.fn<(planId: number, method: string) => Promise<string>>(),
		cancelSubscription: vi.fn<(uuid: string) => Promise<void>>(),
		generateInvoice: vi.fn<(uuid: string) => Promise<Uint8Array>>(),
		withdrawSubscription: vi.fn<(uuid: string, name: string, email: string, lang: string) => Promise<bigint>>()
	},
	accountQueryUpdate: vi.fn<(updater: (prev: UserInfo) => UserInfo, options?: { readNow?: boolean }) => void>(),
	fetchAccountFresh: vi.fn<() => Promise<UserInfo>>(),
	downloadBlob: vi.fn<(filename: string, blob: Blob) => void>()
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: sdk }))
vi.mock("@/queries/account", () => ({ accountQueryUpdate, fetchAccountFresh }))
vi.mock("@/lib/downloadBlob", () => ({ downloadBlob }))

import {
	billingErrorLabel,
	cancelSubscription,
	createCheckout,
	downloadInvoice,
	forgetCheckouts,
	setAppearOffline,
	withdrawSubscription
} from "@/features/settings/lib/billingActions"

function serverError(code: string): ErrorDTO {
	return { species: "sdk", kind: "Server", label: "x", message: "x", serverMessage: `server says ${code}`, serverCode: code }
}

function account(subs: Partial<UserAccountSubs>[]): UserInfo {
	return { subs } as unknown as UserInfo
}

// The patch a write applied, run over a given account.
function appliedPatch(prev: UserInfo): UserInfo {
	const updater = accountQueryUpdate.mock.calls[0]?.[0]

	if (updater === undefined) {
		throw new Error("no account patch")
	}

	return updater(prev)
}

beforeEach(() => {
	onlineManager.setOnline(true)
	forgetCheckouts()
})

afterEach(() => {
	onlineManager.setOnline(true)
})

describe("createCheckout", () => {
	it("creates a (plan, method) checkout once and shares it", async () => {
		sdk.createSubscription.mockResolvedValue("https://checkout.example/a")

		const [first, second] = await Promise.all([createCheckout(27, "stripe"), createCheckout(27, "stripe")])
		const third = await createCheckout(27, "stripe")

		expect(first).toEqual({ status: "success", item: "https://checkout.example/a" })
		expect(second).toEqual(first)
		expect(third).toEqual(first)
		expect(sdk.createSubscription).toHaveBeenCalledTimes(1)

		await createCheckout(27, "paypal")

		expect(sdk.createSubscription).toHaveBeenCalledTimes(2)
	})

	it("asks again after a refusal", async () => {
		sdk.createSubscription.mockRejectedValueOnce(serverError("rate_limited")).mockResolvedValueOnce("https://checkout.example/b")

		expect((await createCheckout(30, "stripe")).status).toBe("error")
		expect(await createCheckout(30, "stripe")).toEqual({ status: "success", item: "https://checkout.example/b" })
	})

	it("refuses a URL that is not https", async () => {
		sdk.createSubscription.mockResolvedValue("javascript:alert(1)")

		expect((await createCheckout(33, "stripe")).status).toBe("error")
	})

	it("never calls the SDK offline", async () => {
		onlineManager.setOnline(false)

		expect((await createCheckout(27, "stripe")).status).toBe("error")
		expect(sdk.createSubscription).not.toHaveBeenCalled()
	})
})

describe("cancelSubscription", () => {
	it("patches the cached subscription without a read back", async () => {
		sdk.cancelSubscription.mockResolvedValue(undefined)

		expect(await cancelSubscription({ id: "b" })).toEqual({ status: "success" })
		expect(sdk.cancelSubscription).toHaveBeenCalledWith("b")
		expect(accountQueryUpdate.mock.calls[0]?.[1]).toEqual({ readNow: false })
		expect(
			appliedPatch(
				account([
					{ id: "a", cancelled: false },
					{ id: "b", cancelled: false }
				])
			).subs.map(sub => sub.cancelled)
		).toEqual([false, true])
	})

	it("leaves the cache alone on a refusal", async () => {
		sdk.cancelSubscription.mockRejectedValue(serverError("cannot_cancel_sub_now"))

		const outcome = await cancelSubscription({ id: "b" })

		expect(outcome.status).toBe("error")
		expect(accountQueryUpdate).not.toHaveBeenCalled()
	})

	it("refuses offline", async () => {
		onlineManager.setOnline(false)

		expect((await cancelSubscription({ id: "b" })).status).toBe("error")
		expect(sdk.cancelSubscription).not.toHaveBeenCalled()
	})
})

describe("withdrawSubscription", () => {
	const request = { subId: "b", name: "Jane Doe", email: "jane@example.com", lang: "en" as const }

	it("records when the withdrawal was received in the cache", async () => {
		sdk.withdrawSubscription.mockResolvedValue(1_000n)

		expect(await withdrawSubscription(request)).toEqual({ status: "received", at: 1_000n })
		expect(sdk.withdrawSubscription).toHaveBeenCalledWith("b", "Jane Doe", "jane@example.com", "en")
		expect(appliedPatch(account([{ id: "a" }, { id: "b" }])).subs.map(sub => sub.withdrawRequested)).toEqual([undefined, 1_000n])
		expect(fetchAccountFresh).not.toHaveBeenCalled()
	})

	it("treats a repeated withdrawal as received, with the first one's time", async () => {
		sdk.withdrawSubscription.mockResolvedValue(500n)

		expect(await withdrawSubscription(request)).toEqual({ status: "received", at: 500n })
	})

	it("reports a withdrawal the server recorded before failing as received without a confirmed email", async () => {
		sdk.withdrawSubscription.mockRejectedValue(serverError("internal_error"))
		fetchAccountFresh.mockResolvedValue(account([{ id: "b", withdrawRequested: 700n }]))

		expect(await withdrawSubscription(request)).toEqual({ status: "unconfirmed", at: 700n })
	})

	it("passes a refusal through when the fresh read shows no withdrawal", async () => {
		const refusal = serverError("cannot_withdraw_sub_now")

		sdk.withdrawSubscription.mockRejectedValue(refusal)
		fetchAccountFresh.mockResolvedValue(account([{ id: "b" }]))

		expect(await withdrawSubscription(request)).toEqual({ status: "error", dto: refusal })
	})

	it("passes the refusal through when the fresh read fails too", async () => {
		sdk.withdrawSubscription.mockRejectedValue(serverError("sub_not_found"))
		fetchAccountFresh.mockRejectedValue(new Error("offline"))

		expect((await withdrawSubscription(request)).status).toBe("error")
	})

	it("refuses offline", async () => {
		onlineManager.setOnline(false)

		expect((await withdrawSubscription(request)).status).toBe("error")
		expect(sdk.withdrawSubscription).not.toHaveBeenCalled()
	})
})

describe("downloadInvoice", () => {
	it("saves the PDF as Invoice_<id>.pdf", async () => {
		sdk.generateInvoice.mockResolvedValue(new Uint8Array([1, 2, 3]))

		expect(await downloadInvoice({ id: "inv-1" })).toEqual({ status: "success" })

		const [name, blob] = downloadBlob.mock.calls[0] ?? []

		expect(name).toBe("Invoice_inv-1.pdf")
		expect(blob?.type).toBe("application/pdf")
		expect(blob?.size).toBe(3)
	})

	it("saves nothing on a refusal", async () => {
		sdk.generateInvoice.mockRejectedValue(serverError("invoice_not_found"))

		expect((await downloadInvoice({ id: "inv-1" })).status).toBe("error")
		expect(downloadBlob).not.toHaveBeenCalled()
	})
})

describe("setAppearOffline", () => {
	it("passes through online and refuses offline", async () => {
		sdk.setAppearOffline.mockResolvedValue(undefined)

		await setAppearOffline(true)

		expect(sdk.setAppearOffline).toHaveBeenCalledWith(true)

		onlineManager.setOnline(false)

		await expect(setAppearOffline(false)).rejects.toBeDefined()
		expect(sdk.setAppearOffline).toHaveBeenCalledTimes(1)
	})
})

describe("billingErrorLabel", () => {
	it("words the billing server codes", () => {
		expect(billingErrorLabel(serverError("cannot_cancel_sub_now"))).toMatch(/24 hours/)
		expect(billingErrorLabel(serverError("cannot_withdraw_sub_now"))).toMatch(/withdrawal period/)
		expect(billingErrorLabel(serverError("plan_not_active"))).toMatch(/no longer available/)
		expect(billingErrorLabel(serverError("rate_limited"))).toMatch(/Too many attempts/)
	})

	it("falls back to the general label for other codes", () => {
		expect(billingErrorLabel(serverError("something_else"))).toBe("server says something_else")
	})
})
