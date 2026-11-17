// vite/encoding-detect-plugin.ts: the encoding detector's wasm module, as this build serves it (content-hashed, same
// origin).
declare module "virtual:encoding-detect" {
	export const ENCODING_DETECT_WASM: string
}
