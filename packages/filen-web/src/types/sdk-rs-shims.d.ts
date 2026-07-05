// The shipped sdk-rs.d.ts has three broken declarations (wasm-surface.md §5):
//   DateTime<Utc> (billing types, lines ~1128/1140), LogLevel (degenerate union), EncryptedString (unknown).
// skipLibCheck neutralizes them UNTIL a use site touches them — slice 0 touches none
// (billing types are a late-slice concern; shims for them land there or upstream fixes first — B3).
// This file only adds what slice 0 actually needs and the .d.ts omits:
declare module "@filen/sdk-rs" {
	// JsClient exists at runtime (spike E8) but is absent from the shipped types.
	export const JsClient: unknown
}
