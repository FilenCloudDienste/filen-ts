import { fileURLToPath } from "node:url"

// MuPDF's wasm beside its module, outside the package's exports: the page compiles it (features/pdf/session/
// engineModule.ts) and hands the module to the engine worker, so the import is `mupdf-wasm?url`. The app and its tests
// resolve it alike.
const MUPDF_WASM = fileURLToPath(new URL("mupdf-wasm.wasm", import.meta.resolve("mupdf")))

export const MUPDF_WASM_ALIAS = { find: /^mupdf-wasm(\?url)$/, replacement: `${MUPDF_WASM}$1` }
