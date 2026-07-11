import { beforeEach, describe, expect, it, vi } from "vitest"
import type { StringifiedClient } from "@filen/sdk-rs"
import {
	runChangeEmailAttempt,
	type ChangeEmailAttemptDeps,
	type ChangeEmailParams
} from "@/features/settings/components/account/changeEmail.logic"
import { log } from "@/lib/log"

function sampleBlob(): StringifiedClient {
	return {
		email: "new@example.com",
		userId: 123456789012345678n,
		rootUuid: "root-uuid",
		authInfo: "auth-info",
		privateKey: "private-key",
		apiKey: "api-key",
		authVersion: 2
	}
}

const PARAMS: ChangeEmailParams = { password: "pw", newEmail: "new@example.com" }

function makeHarness() {
	const changeEmail = vi.fn<(params: ChangeEmailParams) => Promise<void>>()
	const toStringified = vi.fn<() => Promise<StringifiedClient>>()
	const persist = vi.fn<(blob: StringifiedClient) => Promise<void>>().mockResolvedValue(undefined)
	const clearSession = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
	const deps: ChangeEmailAttemptDeps = { changeEmail, toStringified, persist, clearSession }
	return { deps, changeEmail, toStringified, persist, clearSession }
}

beforeEach(() => {
	vi.restoreAllMocks()
})

describe("runChangeEmailAttempt (injected deps, no worker)", () => {
	it("re-reads the live client via toStringified and persists it — the same fingerprint re-sync law as changePassword, adapted for changeEmail's void return", async () => {
		const h = makeHarness()
		const blob = sampleBlob()
		h.changeEmail.mockResolvedValue(undefined)
		h.toStringified.mockResolvedValue(blob)

		await expect(runChangeEmailAttempt(h.deps, PARAMS)).resolves.toEqual({ status: "success", persisted: true })

		expect(h.changeEmail).toHaveBeenCalledTimes(1)
		expect(h.changeEmail).toHaveBeenCalledWith(PARAMS)
		expect(h.toStringified).toHaveBeenCalledTimes(1)
		expect(h.persist).toHaveBeenCalledTimes(1)
		expect(h.persist).toHaveBeenCalledWith(blob)
		expect(h.clearSession).not.toHaveBeenCalled()
	})

	it("a changeEmail failure never reaches toStringified or persist", async () => {
		const h = makeHarness()
		const error = { species: "sdk" as const, kind: "WrongPassword", message: "wrong password", label: "wrong password" }
		h.changeEmail.mockRejectedValue(error)

		const outcome = await runChangeEmailAttempt(h.deps, PARAMS)

		expect(outcome).toEqual({ status: "error", dto: error })
		expect(h.toStringified).not.toHaveBeenCalled()
		expect(h.persist).not.toHaveBeenCalled()
	})

	it("a toStringified failure after a successful mutation is not a change-email failure: warns, reports success with persisted:false, clears the stale session", async () => {
		const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined)
		const h = makeHarness()
		h.changeEmail.mockResolvedValue(undefined)
		h.toStringified.mockRejectedValue(new Error("worker unreachable"))

		await expect(runChangeEmailAttempt(h.deps, PARAMS)).resolves.toEqual({ status: "success", persisted: false })

		expect(warnSpy).toHaveBeenCalledWith("settings", expect.stringContaining("toStringified failed"), expect.anything())
		expect(h.persist).not.toHaveBeenCalled()
		expect(h.clearSession).toHaveBeenCalledTimes(1)
	})

	it("a persist failure after a successful re-read still reports success with persisted:false and clears the stale session", async () => {
		vi.spyOn(log, "warn").mockImplementation(() => undefined)
		const h = makeHarness()
		h.changeEmail.mockResolvedValue(undefined)
		h.toStringified.mockResolvedValue(sampleBlob())
		h.persist.mockRejectedValue(new Error("kv write failed"))

		await expect(runChangeEmailAttempt(h.deps, PARAMS)).resolves.toEqual({ status: "success", persisted: false })

		expect(h.clearSession).toHaveBeenCalledTimes(1)
	})

	it("a clearSession failure after a persist failure is swallowed: still success with persisted:false, no throw", async () => {
		vi.spyOn(log, "warn").mockImplementation(() => undefined)
		const h = makeHarness()
		h.changeEmail.mockResolvedValue(undefined)
		h.toStringified.mockResolvedValue(sampleBlob())
		h.persist.mockRejectedValue(new Error("kv write failed"))
		h.clearSession.mockRejectedValue(new Error("kv delete failed"))

		await expect(runChangeEmailAttempt(h.deps, PARAMS)).resolves.toEqual({ status: "success", persisted: false })

		expect(h.clearSession).toHaveBeenCalledTimes(1)
	})
})
