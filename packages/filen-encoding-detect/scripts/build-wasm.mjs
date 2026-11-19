// Builds the encoding detector's wasm module (crate/, wasm32-unknown-unknown, release) and copies it to
// dist/filen_encoding_detect.wasm, through the build shared with the other wasm package (scripts/build-rust-wasm.mjs at the
// repository root).
//
//   pnpm run build:wasm

import { fileURLToPath } from "node:url"
import { runIfMain, rustWasmBuild } from "../../../scripts/build-rust-wasm.mjs"

const build = rustWasmBuild({
	packageDir: fileURLToPath(new URL("..", import.meta.url)),
	artifact: "filen_encoding_detect",
	remapName: "/filen-encoding-detect"
})

export const WASM_PATH = build.WASM_PATH
export const buildWasm = build.buildWasm

await runIfMain(import.meta.url, buildWasm)
