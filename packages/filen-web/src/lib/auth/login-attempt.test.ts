import { beforeEach, describe, expect, it, vi } from "vitest"
import type { StringifiedClient } from "@filen/sdk-rs"
import { runLoginAttempt, type LoginAttemptDeps, type LoginParams } from "@/lib/auth/login-attempt"
import { toErrorDTO, type ErrorDTO } from "@/lib/sdk/errors"
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

// All collaborators injected — no module mocks; `bump()` simulates the user dismissing the
// two-factor dialog mid-flight (the caller increments its generation counter on dismissal).
function makeHarness() {
	let generation = 0
	const login = vi.fn<(params: LoginParams) => Promise<StringifiedClient>>()
	const logout = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
	const persist = vi.fn<(blob: StringifiedClient) => Promise<void>>().mockResolvedValue(undefined)
	const broadcast = vi.fn<() => void>()
	const deps: LoginAttemptDeps = { login, logout, persist, broadcast, generation: () => generation }
	return {
		deps,
		login,
		logout,
		persist,
		broadcast,
		bump: () => {
			generation += 1
		}
	}
}

const PARAMS: LoginParams = { email: "user@example.com", password: "pw" }

beforeEach(() => {
	vi.restoreAllMocks()
})

describe("runLoginAttempt (injected deps, no worker)", () => {
	it("current-generation success persists, broadcasts and reports persisted", async () => {
		const h = makeHarness()
		const blob = sampleBlob()
		h.login.mockResolvedValue(blob)

		await expect(runLoginAttempt(h.deps, PARAMS)).resolves.toEqual({ status: "success", persisted: true })

		expect(h.persist).toHaveBeenCalledTimes(1)
		expect(h.persist).toHaveBeenCalledWith(blob)
		expect(h.broadcast).toHaveBeenCalledTimes(1)
		expect(h.logout).not.toHaveBeenCalled()
	})

	it("stale success discards the login: logs the worker out, never persists/broadcasts", async () => {
		const h = makeHarness()
		let resolveLogin!: (blob: StringifiedClient) => void
		h.login.mockImplementation(
			() =>
				new Promise<StringifiedClient>(resolve => {
					resolveLogin = resolve
				})
		)

		const attempt = runLoginAttempt(h.deps, PARAMS)
		h.bump() // dialog dismissed while the login round-trip is in flight
		resolveLogin(sampleBlob())

		await expect(attempt).resolves.toEqual({ status: "stale" })
		expect(h.logout).toHaveBeenCalledTimes(1)
		expect(h.persist).not.toHaveBeenCalled()
		expect(h.broadcast).not.toHaveBeenCalled()
	})

	it("stale Wrong2fa is swallowed: no two-factor outcome, no logout", async () => {
		const h = makeHarness()
		let rejectLogin!: (e: unknown) => void
		h.login.mockImplementation(
			() =>
				new Promise<StringifiedClient>((_resolve, reject) => {
					rejectLogin = reject
				})
		)

		const attempt = runLoginAttempt(h.deps, PARAMS)
		h.bump() // dialog dismissed while the retry is in flight
		rejectLogin(sdkDto("Wrong2fa"))

		await expect(attempt).resolves.toEqual({ status: "stale" })
		expect(h.logout).not.toHaveBeenCalled()
		expect(h.persist).not.toHaveBeenCalled()
		expect(h.broadcast).not.toHaveBeenCalled()
	})

	it("current-generation Enter2fa/Wrong2fa map to the two-factor outcome with the right wrongCode", async () => {
		const h = makeHarness()

		h.login.mockRejectedValueOnce(sdkDto("Enter2fa"))
		await expect(runLoginAttempt(h.deps, PARAMS)).resolves.toEqual({ status: "two-factor", wrongCode: false })

		h.login.mockRejectedValueOnce(sdkDto("Wrong2fa"))
		await expect(runLoginAttempt(h.deps, PARAMS)).resolves.toEqual({ status: "two-factor", wrongCode: true })

		expect(h.logout).not.toHaveBeenCalled()
	})

	// errors.test.ts proves toErrorDTO's shape detection in isolation; the test above proves the
	// two-factor branch in isolation against a hand-built DTO literal. Neither closes the gap between
	// them: a live FilenSdkError never survives Comlink intact (it clones hollow — see errors.ts's
	// header), so the worker always runs it through toErrorDTO BEFORE the rejection crosses the
	// boundary (sdk.worker.ts's Proxy wrapper). This runs a live-shaped 2FA throw through the REAL
	// toErrorDTO and feeds its actual output into the branch, proving the two conversion layers agree
	// on the kind a production worker throw would actually carry.
	class LiveTwoFactorError {
		kind: string
		constructor(kind: string) {
			this.kind = kind
		}
		message(): string {
			return "outer"
		}
		server_message(): string {
			return ""
		}
	}

	it("branches correctly on a DTO produced by the real toErrorDTO from a live-shaped 2fa throw", async () => {
		const h = makeHarness()

		h.login.mockRejectedValueOnce(toErrorDTO(new LiveTwoFactorError("Enter2fa")))
		await expect(runLoginAttempt(h.deps, PARAMS)).resolves.toEqual({ status: "two-factor", wrongCode: false })

		h.login.mockRejectedValueOnce(toErrorDTO(new LiveTwoFactorError("Wrong2fa")))
		await expect(runLoginAttempt(h.deps, PARAMS)).resolves.toEqual({ status: "two-factor", wrongCode: true })

		expect(h.logout).not.toHaveBeenCalled()
	})

	it("any other failure passes the DTO through unchanged", async () => {
		const h = makeHarness()
		const dto = sdkDto("EmailOrPasswordWrong")
		h.login.mockRejectedValue(dto)

		const outcome = await runLoginAttempt(h.deps, PARAMS)

		expect(outcome.status).toBe("error")
		if (outcome.status === "error") {
			expect(outcome.dto).toBe(dto) // asErrorDTO passes an existing DTO through by reference
		}
	})

	it("a persist failure is not a login failure: warns, skips broadcast, still succeeds", async () => {
		const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined)
		const h = makeHarness()
		h.login.mockResolvedValue(sampleBlob())
		h.persist.mockRejectedValue(new Error("kv write failed"))

		await expect(runLoginAttempt(h.deps, PARAMS)).resolves.toEqual({ status: "success", persisted: false })

		expect(h.broadcast).not.toHaveBeenCalled()
		expect(h.logout).not.toHaveBeenCalled()
		expect(warnSpy).toHaveBeenCalledWith("login", expect.stringContaining("persist failed"), expect.anything())
	})
})
