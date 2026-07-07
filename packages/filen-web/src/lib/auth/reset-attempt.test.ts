import { beforeEach, describe, expect, it, vi } from "vitest"
import type { StringifiedClient } from "@filen/sdk-rs"
import { runResetAttempt, type ResetAttemptDeps, type ResetParams } from "@/lib/auth/reset-attempt"
import type { ErrorDTO } from "@/lib/sdk/errors"
import { log } from "@/lib/log"

function sampleBlob(): StringifiedClient {
	return {
		email: "user@example.com",
		userId: 123456789012345678n,
		rootUuid: "root-uuid",
		authInfo: "auth-info",
		privateKey: "private-key",
		apiKey: "api-key",
		authVersion: 2
	}
}

// Worker-boundary errors arrive as plain DTOs (the Comlink proxy throws toErrorDTO output), so the
// rejections here are literal DTO objects, exactly the shape the helper sees in production.
function sdkDto(kind: string): ErrorDTO {
	return { species: "sdk", kind, message: `${kind} message`, label: `${kind} label` }
}

function plainDto(message: string): ErrorDTO {
	return { species: "plain", message, label: message }
}

// All collaborators injected — no worker, no module mocks.
function makeHarness() {
	const completeReset = vi.fn<(params: ResetParams) => Promise<StringifiedClient>>()
	const persist = vi.fn<(blob: StringifiedClient) => Promise<void>>().mockResolvedValue(undefined)
	const broadcast = vi.fn<() => void>()
	const deps: ResetAttemptDeps = { completeReset, persist, broadcast }
	return { deps, completeReset, persist, broadcast }
}

const PARAMS: ResetParams = { token: "reset-token", email: "user@example.com", newPassword: "new-password" }

beforeEach(() => {
	vi.restoreAllMocks()
})

describe("runResetAttempt (injected deps, no worker)", () => {
	it("success persists, broadcasts and reports persisted", async () => {
		const h = makeHarness()
		const blob = sampleBlob()
		h.completeReset.mockResolvedValue(blob)

		await expect(runResetAttempt(h.deps, PARAMS)).resolves.toEqual({ status: "success", persisted: true })

		expect(h.completeReset).toHaveBeenCalledTimes(1)
		expect(h.completeReset).toHaveBeenCalledWith(PARAMS)
		expect(h.persist).toHaveBeenCalledWith(blob)
		expect(h.broadcast).toHaveBeenCalledTimes(1)
	})

	it("passes the imported master-keys file text through untouched, alongside the other params", async () => {
		const h = makeHarness()
		h.completeReset.mockResolvedValue(sampleBlob())
		const withKeys: ResetParams = { ...PARAMS, masterKeysFileText: "_VALID_FILEN_MASTERKEY_deadbeef@123_VALID_FILEN_MASTERKEY_" }

		await runResetAttempt(h.deps, withKeys)

		expect(h.completeReset).toHaveBeenCalledWith(withKeys)
	})

	it("a persist failure is not a reset failure: warns, skips broadcast, still succeeds", async () => {
		const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined)
		const h = makeHarness()
		h.completeReset.mockResolvedValue(sampleBlob())
		h.persist.mockRejectedValue(new Error("kv write failed"))

		await expect(runResetAttempt(h.deps, PARAMS)).resolves.toEqual({ status: "success", persisted: false })

		expect(h.broadcast).not.toHaveBeenCalled()
		expect(warnSpy).toHaveBeenCalledWith("reset", "session persist failed", expect.anything())
	})

	it("a rejected master-keys file (BadRecoveryKey) passes the DTO through unchanged, never persists", async () => {
		const h = makeHarness()
		const dto = sdkDto("BadRecoveryKey")
		h.completeReset.mockRejectedValue(dto)

		const outcome = await runResetAttempt(h.deps, { ...PARAMS, masterKeysFileText: "bad-keys" })

		expect(outcome).toEqual({ status: "error", dto })
		expect(h.persist).not.toHaveBeenCalled()
		expect(h.broadcast).not.toHaveBeenCalled()
	})

	it("an expired/invalid token surfaces as a generic server error DTO, LABEL-FIRST", async () => {
		const h = makeHarness()
		const dto = plainDto("token invalid or expired")
		h.completeReset.mockRejectedValue(dto)

		await expect(runResetAttempt(h.deps, PARAMS)).resolves.toEqual({ status: "error", dto })
	})
})
