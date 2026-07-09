// libheif-js ships types for the plain Emscripten glue (libheif-wasm/libheif.d.ts) only — nothing
// covers the ESM WASM-inlined bundle at this exact subpath, which is what heic-codec.ts's
// initLibheifDecoder imports. Shimmed for exactly the one export used: a factory whose real return
// value isn't typed anywhere upstream, so the call site casts it to its own HeicDecoderModule shape —
// a scoped, deliberate cast against a hand-written interface, not a null-strip.
declare module "libheif-js/libheif-wasm/libheif-bundle.mjs" {
	type HeicBundleFactory = (options?: Record<string, unknown>) => unknown

	const heicBundleFactory: HeicBundleFactory

	export default heicBundleFactory
}
