import * as z from "zod/mini"

// Same reason as assistant/tool.ts: the web CSP reports zod's eval probe. Must run before the schemas below exist.
// zod/mini keeps the desktop shell's main bundle from carrying the whole of zod for two schemas.
z.config({ jitless: true })

// The persisted SDK session (`@filen/sdk-rs` StringifiedClient) after the envelope revived it. Loose like the SDK
// type's own evolution: a field a newer SDK adds passes through to `fromStringified` instead of being stripped.
export const sessionSchema = z.looseObject({
	email: z.string(),
	userId: z.bigint(),
	rootUuid: z.string(),
	authInfo: z.string(),
	privateKey: z.string(),
	apiKey: z.string(),
	authVersion: z.number(),
	maxParallelRequests: z.exactOptional(z.number()),
	maxIoMemoryUsage: z.exactOptional(z.number())
})

// The same session as plain JSON on the wire, before the envelope revives `userId` (`$bigint:<digits>n`). The desktop
// shell checks the shape with this before storing a blob it never otherwise reads.
export const sessionEnvelopeSchema = z.extend(sessionSchema, {
	userId: z.string().check(z.regex(/^\$bigint:\d+n$/))
})
