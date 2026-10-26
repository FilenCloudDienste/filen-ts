import { type } from "arktype"

// The persisted SDK session (`@filen/sdk-rs` StringifiedClient) after the envelope revived it. Undeclared keys pass
// through, so a field a newer SDK adds reaches `fromStringified` instead of being stripped.
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

// The same session as plain JSON on the wire, before the envelope revives `userId` (`$bigint:<digits>n`). The desktop
// shell checks the shape with this before storing a blob it never otherwise reads.
export const sessionEnvelopeSchema = sessionSchema.merge({
	userId: /^\$bigint:\d+n$/
})
