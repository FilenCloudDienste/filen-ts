import { describe, expect, it } from "vitest"
import { sessionEnvelopeSchema, sessionSchema } from "@filen/shared/session"

const session = {
	email: "user@example.com",
	userId: 123456789012345678n,
	rootUuid: "root-uuid",
	authInfo: "auth-info",
	privateKey: "private-key",
	apiKey: "api-key",
	authVersion: 2
}

describe("sessionSchema", () => {
	it("accepts a revived session and keeps fields a newer SDK adds", () => {
		const parsed = sessionSchema.parse({ ...session, maxParallelRequests: 4, future: "x" })

		expect(parsed).toEqual({ ...session, maxParallelRequests: 4, future: "x" })
	})

	it("rejects a number userId and missing or mistyped fields", () => {
		expect(sessionSchema.safeParse({ ...session, userId: 1 }).success).toBe(false)
		expect(sessionSchema.safeParse({ ...session, apiKey: undefined }).success).toBe(false)
		expect(sessionSchema.safeParse({ ...session, maxIoMemoryUsage: "1" }).success).toBe(false)
		expect(sessionSchema.safeParse({ ...session, maxIoMemoryUsage: undefined }).success).toBe(false)
	})
})

describe("sessionEnvelopeSchema", () => {
	it("accepts the envelope form of userId only", () => {
		const wire = { ...session, userId: "$bigint:123456789012345678n" }

		expect(sessionEnvelopeSchema.safeParse(wire).success).toBe(true)
		expect(sessionEnvelopeSchema.safeParse(session).success).toBe(false)
		expect(sessionEnvelopeSchema.safeParse({ ...session, userId: "123" }).success).toBe(false)
		expect(sessionEnvelopeSchema.safeParse({ ...session, userId: "$bigint:12x3n" }).success).toBe(false)
	})
})
