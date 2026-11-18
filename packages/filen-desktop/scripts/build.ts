import { copyFileSync, mkdirSync } from "node:fs"
import path from "node:path"
import { build } from "esbuild"
import { bundleOptions } from "./bundles.ts"
import { THIRD_PARTY_NOTICES_DIST, THIRD_PARTY_NOTICES_SOURCE } from "./thirdPartyNoticesSources.ts"

await Promise.all(bundleOptions().map(options => build(options)))

// The third-party notices main answers the page with, read from beside main.js only when the dialog opens.
mkdirSync(path.dirname(THIRD_PARTY_NOTICES_DIST), { recursive: true })
copyFileSync(THIRD_PARTY_NOTICES_SOURCE, THIRD_PARTY_NOTICES_DIST)
