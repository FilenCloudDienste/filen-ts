// libheif-js ships types only for the raw Emscripten glue (libheif-wasm/libheif.d.ts), not for the
// ESM WASM-inlined bundle heic-transform.ts actually imports (libheif-wasm/libheif-bundle.mjs) — no
// .d.ts covers that exact subpath. Minimal ambient shim for the one thing needed: a factory returning
// the library's runtime surface. The factory's real return shape isn't declared anywhere upstream, so
// heic-transform.ts narrows it to its own HeicDecoderModule interface via an explicit assertion — a
// scoped, deliberate cast against a hand-written shape, not a null-strip.
declare module "libheif-js/libheif-wasm/libheif-bundle.mjs" {
	function createLibheif(options?: Record<string, unknown>): unknown

	export default createLibheif
}
