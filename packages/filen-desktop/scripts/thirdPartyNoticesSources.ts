import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { DesktopThirdPartyNotice, DesktopThirdPartyNotices } from "@filen/shared/desktop"
import { build } from "esbuild"
import { THIRD_PARTY_NOTICES_FILE } from "../src/main/thirdPartyNotices.ts"
import { bundleOptions } from "./bundles.ts"

// What the third-party notices generator (scripts/generateThirdPartyNotices.ts) and its drift test both read, so the
// two sides of every comparison come from one definition.

export const packageDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
export const THIRD_PARTY_NOTICES_SOURCE = path.join(packageDir, "src", "main", "thirdPartyNotices.gen.json")
// Beside main.js, where main reads it.
export const THIRD_PARTY_NOTICES_DIST = path.join(packageDir, "dist", THIRD_PARTY_NOTICES_FILE)
export const WEB_NOTICES = path.join(packageDir, "..", "filen-web", "src", "features", "settings", "thirdPartyNotices.gen.ts")
export const DRAG_ADDON_LOCK = path.join(packageDir, "native", "dragOut", "win", "Cargo.lock")
// Compiled into the Swift addons (native/shared): the Node-API headers.
export const NODE_API_HEADERS = "node-api-headers"

export type NoticeEcosystem = DesktopThirdPartyNotice["ecosystem"]

// The committed payload: what it was generated against, then the notices themselves (indices into its own `texts`).
export interface DesktopNoticesFile extends DesktopThirdPartyNotices {
	generated: {
		sdkVersion: string
		filenRsRef: string
		web: { sdkVersion: string; filenRsRef: string }
		fileProviderFilenRs: string
		electron: string
		chromium: string
		node: string
		rclone: string
		go: string
		winfsp: string
	}
}

export function readDesktopNotices(): DesktopNoticesFile {
	return JSON.parse(readFileSync(THIRD_PARTY_NOTICES_SOURCE, "utf8")) as DesktopNoticesFile
}

type WebNotice = Omit<DesktopThirdPartyNotice, "ecosystem"> & { ecosystem: string }

// filen-web's committed payload, which the page always shows; desktop's lists only what it adds.
export function readWebNotices(): {
	sdkVersion: string
	filenRsRef: string
	texts: string[]
	notices: WebNotice[]
} {
	const source = readFileSync(WEB_NOTICES, "utf8")
	const field = (name: string) => new RegExp(`^export const ${name} = (".*")$`, "m").exec(source)?.[1]
	const sdkVersion = field("THIRD_PARTY_NOTICES_SDK_VERSION")
	const filenRsRef = field("THIRD_PARTY_NOTICES_FILEN_RS_REF")
	const payload = field("THIRD_PARTY_NOTICES_PAYLOAD")

	if (sdkVersion === undefined || filenRsRef === undefined || payload === undefined) {
		throw new Error(`${WEB_NOTICES} is not a generated notices payload`)
	}

	return {
		sdkVersion: JSON.parse(sdkVersion) as string,
		filenRsRef: JSON.parse(filenRsRef) as string,
		...(JSON.parse(JSON.parse(payload) as string) as { texts: string[]; notices: WebNotice[] })
	}
}

export interface BundledPackage {
	name: string
	version: string
	dir: string
}

// The npm packages esbuild bundles into dist/ (main, native host, preload), read from the bundles' metafiles: the
// package that owns each input file. Workspace sources (@filen/shared) are first-party and resolve outside
// node_modules, so they are not listed. Nothing is written.
export async function bundledNpmPackages(): Promise<BundledPackage[]> {
	const previous = process.cwd()
	const packages = new Map<string, BundledPackage>()

	process.chdir(packageDir)

	try {
		for (const options of bundleOptions()) {
			const { metafile } = await build({ ...options, write: false, metafile: true, sourcemap: false, logLevel: "silent" })

			for (const input of Object.keys(metafile.inputs)) {
				const at = input.lastIndexOf("node_modules/")

				if (at === -1) {
					continue
				}

				const segments = input.slice(at + "node_modules/".length).split("/")
				const name = segments[0]?.startsWith("@") === true ? `${segments[0]}/${segments[1] ?? ""}` : (segments[0] ?? "")
				const dir = path.resolve(packageDir, input.slice(0, at + "node_modules/".length + name.length))
				const { version } = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as { version: string }

				packages.set(`${name}@${version}`, { name, version, dir })
			}
		}
	} finally {
		process.chdir(previous)
	}

	return [...packages.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
}
