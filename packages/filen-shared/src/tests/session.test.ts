import { describe, expect, it } from "vitest"
import { type } from "arktype"
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

function accepts(schema: (value: unknown) => unknown, value: unknown): boolean {
	return !(schema(value) instanceof type.errors)
}

describe("sessionSchema", () => {
	it("accepts a revived session and keeps fields a newer SDK adds", () => {
		expect(sessionSchema({ ...session, maxParallelRequests: 4, future: "x" })).toEqual({ ...session, maxParallelRequests: 4, future: "x" })
	})

	it("rejects a number userId and missing or mistyped fields", () => {
		expect(accepts(sessionSchema, { ...session, userId: 1 })).toBe(false)
		expect(accepts(sessionSchema, { ...session, apiKey: undefined })).toBe(false)
		expect(accepts(sessionSchema, { ...session, maxIoMemoryUsage: "1" })).toBe(false)
		expect(accepts(sessionSchema, { ...session, maxIoMemoryUsage: undefined })).toBe(false)
	})
})

describe("sessionEnvelopeSchema", () => {
	it("accepts the envelope form of userId only", () => {
		const wire = { ...session, userId: "$bigint:123456789012345678n" }

		expect(accepts(sessionEnvelopeSchema, wire)).toBe(true)
		expect(accepts(sessionEnvelopeSchema, session)).toBe(false)
		expect(accepts(sessionEnvelopeSchema, { ...session, userId: "123" })).toBe(false)
		expect(accepts(sessionEnvelopeSchema, { ...session, userId: "$bigint:12x3n" })).toBe(false)
	})
})
