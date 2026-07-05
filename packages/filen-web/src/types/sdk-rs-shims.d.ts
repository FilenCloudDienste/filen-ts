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
}
