// The shipped sdk-rs.d.ts has three broken declarations (wasm-surface.md §5):
//   DateTime<Utc> (billing types, lines ~1128/1140), LogLevel (degenerate union), EncryptedString (unknown).
// skipLibCheck neutralizes them UNTIL a use site touches them — slice 0 touches none
// (billing types are a late-slice concern; shims for them land there or upstream fixes first — B3).
// This file only adds what slice 0 actually needs and the .d.ts omits.
//
// The side-effect import below is load-bearing: it makes this file a MODULE so the block AUGMENTS
// the resolved package types. Without it this .d.ts is a script, and a script-context
// `declare module "@filen/sdk-rs"` SHADOWS the real sdk-rs.d.ts surface wholesale (every real
// export — init, initThreadPool, UnauthClient, Client, … — silently vanishes). This stayed latent
// through T2 because nothing imported the package yet; T3's sdk.worker is the first importer.
import "@filen/sdk-rs"

declare module "@filen/sdk-rs" {
	// JsClient exists at runtime (spike E8) but is absent from the shipped types.
	export const JsClient: unknown
}
