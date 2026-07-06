import { type } from "arktype"

// The single kv key the persisted SDK session blob lives under. Real authentication (login + 2FA
// wired to the worker) arrives in a later slice; this constant is the seam it slots into, so the
// eventual save/restore path and today's test-only session injection agree on one key instead of
// diverging. The blob is written via `kvSetJson` (envelope-serialized, bigint-safe — the
// StringifiedClient carries a bigint `userId`).
export const SESSION_KV_KEY = "sdk.session.v1"

// Schema for the persisted blob — mirrors `@filen/sdk-rs`'s `StringifiedClient` so the future
// restore path can satisfy the D11 "every kv read is arktype-validated" rule without re-deriving it.
export const sessionSchema = type({
	email: "string",
	userId: "bigint",
	rootUuid: "string",
	authInfo: "string",
	privateKey: "string",
	apiKey: "string",
	authVersion: "number",
	"maxParallelRequests?": "number",
	"maxIoMemoryUsage?": "number"
})
