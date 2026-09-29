import { describe, expect, it, vi } from "vitest"
import { attemptOp } from "@/lib/actions/outcome"
import type { ErrorDTO } from "@/lib/sdk/errors"

describe("attemptOp", () => {
	it("resolves a fulfilled op into a success outcome carrying its value", async () => {
		await expect(attemptOp(Promise.resolve(42))).resolves.toStrictEqual({ status: "success", item: 42 })
	})

	it("passes a rejected ErrorDTO through by reference", async () => {
		const dto: ErrorDTO = { species: "plain", message: "boom", label: "boom" }
		const outcome = await attemptOp(vi.fn<() => Promise<number>>().mockRejectedValue(dto)())

		expect(outcome.status).toBe("error")

		if (outcome.status === "error") {
			expect(outcome.dto).toBe(dto)
		}
	})

	it("normalizes a plain Error rejection into an ErrorDTO", async () => {
		const outcome = await attemptOp(Promise.reject(new Error("nope")))

		expect(outcome.status).toBe("error")

		if (outcome.status === "error") {
			expect(outcome.dto.message).toBe("nope")
		}
	})
})
