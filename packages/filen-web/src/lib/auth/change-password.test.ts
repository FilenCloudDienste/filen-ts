import { beforeEach, describe, expect, it, vi } from "vitest"
import type { StringifiedClient } from "@filen/sdk-rs"
import { runChangePasswordAttempt, type ChangePasswordAttemptDeps, type ChangePasswordParams } from "@/lib/auth/change-password"
import { log } from "@/lib/log"

function sampleBlob(): StringifiedClient {
	return {
		email: "user@example.com",
		userId: 123456789012345678n,
		rootUuid: "root-uuid",
		authInfo: "auth-info-after-change",
		privateKey: "private-key-after-change",
		apiKey: "api-key",
		authVersion: 2
	}
}

const PARAMS: ChangePasswordParams = { currentPassword: "old-pw", newPassword: "new-pw" }

function makeHarness() {
	const changePassword = vi.fn<(params: ChangePasswordParams) => Promise<StringifiedClient>>()
	const persist = vi.fn<(blob: StringifiedClient) => Promise<void>>().mockResolvedValue(undefined)
	const clearSession = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
	const deps: ChangePasswordAttemptDeps = { changePassword, persist, clearSession }
	return { deps, changePassword, persist, clearSession }
}

beforeEach(() => {
	vi.restoreAllMocks()
})

describe("runChangePasswordAttempt (injected deps, no worker)", () => {
	it("persists the RETURNED (post-mutation) blob, not the input params — the fingerprint re-sync law", async () => {
		const h = makeHarness()
		const blob = sampleBlob()
		h.changePassword.mockResolvedValue(blob)

		await expect(runChangePasswordAttempt(h.deps, PARAMS)).resolves.toEqual({ status: "success", persisted: true })

		expect(h.changePassword).toHaveBeenCalledTimes(1)
		expect(h.changePassword).toHaveBeenCalledWith(PARAMS)
		expect(h.persist).toHaveBeenCalledTimes(1)
		expect(h.persist).toHaveBeenCalledWith(blob)
		expect(h.clearSession).not.toHaveBeenCalled()
	})

	it("a changePassword failure never reaches persist", async () => {
		const h = makeHarness()
		const error = { species: "sdk" as const, kind: "WrongPassword", message: "wrong password", label: "wrong password" }
		h.changePassword.mockRejectedValue(error)

		const outcome = await runChangePasswordAttempt(h.deps, PARAMS)

		expect(outcome).toEqual({ status: "error", dto: error })
		expect(h.persist).not.toHaveBeenCalled()
	})

	it("a persist failure is not a change-password failure: warns, still reports success with persisted:false", async () => {
		const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined)
		const h = makeHarness()
		h.changePassword.mockResolvedValue(sampleBlob())
		h.persist.mockRejectedValue(new Error("kv write failed"))

		await expect(runChangePasswordAttempt(h.deps, PARAMS)).resolves.toEqual({ status: "success", persisted: false })

		expect(warnSpy).toHaveBeenCalledWith("security", expect.stringContaining("persist failed"), expect.anything())
		expect(h.clearSession).toHaveBeenCalledTimes(1)
	})

	it("a clearSession failure after a persist failure is swallowed: still success with persisted:false, no throw", async () => {
		vi.spyOn(log, "warn").mockImplementation(() => undefined)
		const h = makeHarness()
		h.changePassword.mockResolvedValue(sampleBlob())
		h.persist.mockRejectedValue(new Error("kv write failed"))
		h.clearSession.mockRejectedValue(new Error("kv delete failed"))

		await expect(runChangePasswordAttempt(h.deps, PARAMS)).resolves.toEqual({ status: "success", persisted: false })

		expect(h.clearSession).toHaveBeenCalledTimes(1)
	})
})
