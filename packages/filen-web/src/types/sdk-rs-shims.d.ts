// The shipped sdk-rs.d.ts has three broken declarations:
//   DateTime<Utc> (billing types, lines ~1128/1140), LogLevel (degenerate union), EncryptedString (unknown).
// skipLibCheck neutralizes them until a use site touches them — none are touched yet
// (billing types are a later concern; shims for them land when needed, or upstream fixes first).
// This file only adds what's actually needed and the .d.ts omits.
//
// The side-effect import below is load-bearing: it makes this file a MODULE so the block AUGMENTS
// the resolved package types. Without it this .d.ts is a script, and a script-context
// `declare module "@filen/sdk-rs"` SHADOWS the real sdk-rs.d.ts surface wholesale (every real
// export — init, initThreadPool, UnauthClient, Client, … — silently vanishes). This stayed latent
// until sdk.worker became the first importer of the package.
import "@filen/sdk-rs"

declare module "@filen/sdk-rs" {
	// JsClient exists at runtime but is absent from the shipped types.
	export const JsClient: unknown

	// PasswordState (and, through it, FilePublicLink/DirPublicLinkRW) references these two branded
	// string aliases, but neither is declared or exported anywhere in the shipped .d.ts — the link
	// action surface (get*LinkStatus, *Link{Dir,File}, update*Link) is the first use site to touch
	// them, so backfill the plain string shape here.
	export type LinkHashedPasswordStatic = string
	export type LinkPasswordSalt = string

	// DateTime<Utc> (billing timestamps on UserAccountSubs/UserAccountSubsInvoices) is the chrono-wasm
	// serialization this file's header flagged as broken — neither `DateTime` nor `Utc` is declared or
	// exported anywhere in the shipped .d.ts. The settings billing section is the first use site to
	// touch it; it crosses wasm-bindgen as a plain ISO-8601 string, so `Utc` is an unused marker type
	// and `DateTime<T>` resolves straight to `string`.
	export type Utc = unknown
	// The conditional is a no-op (always resolves to `string`) — it exists only so the type parameter
	// is referenced in the body, satisfying `@typescript-eslint/no-unused-vars` without an eslint-disable.
	export type DateTime<T = Utc> = T extends Utc ? string : string
}
