import { writeFileSync } from "node:fs"
import { OCR_LANGUAGES } from "../src/features/pdf/ocr/languages"
import { TESSDATA_MANIFEST, buildTessdataManifest } from "../vite/ocr-tessdata"

// Rewrites vite/ocr-tessdata.json: the text recognition models of every language the app serves
// (src/features/pdf/ocr/languages.ts) at the given tessdata_fast commit, with their sizes and SHA-256.
//
//   pnpm exec tsx scripts/ocr-tessdata.ts <commit>

const commit = process.argv[2] ?? ""

if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("usage: ocr-tessdata.ts <40-hex tessdata_fast commit>")

const manifest = await buildTessdataManifest(commit, OCR_LANGUAGES)

writeFileSync(TESSDATA_MANIFEST, `${JSON.stringify(manifest, null, "\t")}\n`)

const total = manifest.languages.reduce((sum, language) => sum + language.gzipBytes, 0)

console.log(`${String(manifest.languages.length)} languages, ${(total / 1e6).toFixed(1)} MB compressed -> ${TESSDATA_MANIFEST}`)
