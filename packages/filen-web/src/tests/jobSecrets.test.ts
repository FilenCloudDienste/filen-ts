import { describe, expect, it } from "vitest"
import { forgetJobPassword, holdJobPassword, jobPassword } from "@/features/drive/lib/jobSecrets"

describe("jobSecrets", () => {
	it("holds a job's password until it is forgotten", () => {
		holdJobPassword("a", "secret")

		expect(jobPassword("a")).toBe("secret")
		expect(jobPassword("b")).toBeUndefined()

		forgetJobPassword("a")

		expect(jobPassword("a")).toBeUndefined()
	})

	it("replaces a password, and drops it for a job started without one", () => {
		holdJobPassword("a", "first")
		holdJobPassword("a", "second")

		expect(jobPassword("a")).toBe("second")

		holdJobPassword("a", undefined)

		expect(jobPassword("a")).toBeUndefined()

		holdJobPassword("a", "")

		expect(jobPassword("a")).toBeUndefined()
	})
})
