import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { Plugin } from "vite"
import { type } from "arktype"
import { THEME_COLORS } from "@/providers/themeProvider"

// The install manifest: index.html links it, the deployed CSP (dist/_headers, which the preview server and the
// desktop shell send too) lets the browser fetch it, and every icon it names ships in public/ at its stated size.

const ROOT = join(__dirname, "..", "..")
const PUBLIC = join(ROOT, "public")

const Manifest = type({
	name: "string > 0",
	short_name: "string > 0",
	start_url: "'/'",
	scope: "'/'",
	display: "'standalone'",
	theme_color: /^#[0-9a-f]{6}$/,
	background_color: /^#[0-9a-f]{6}$/,
	icons: type({ src: /^\/[\w.-]+\.png$/, sizes: /^\d+x\d+$/, type: "'image/png'" }).array()
})

function readManifest(): typeof Manifest.infer {
	const parsed = Manifest(JSON.parse(readFileSync(join(PUBLIC, "site.webmanifest"), "utf8")))

	if (parsed instanceof type.errors) {
		throw new Error(parsed.summary)
	}

	return parsed
}

// The emitted dist/_headers, from the build config's own plugin.
async function deployedHeaders(): Promise<string> {
	const factory = (await import("../../vite.config")).default
	const plugin = (factory({ mode: "production", command: "build" }).plugins ?? [])
		.flat()
		.find(
			(entry): entry is Plugin =>
				typeof entry === "object" && entry !== null && "name" in entry && entry.name === "filen:deploy-headers"
		)

	if (plugin === undefined || typeof plugin.generateBundle !== "function") {
		throw new Error("filen:deploy-headers is not in the Vite config")
	}

	let source = ""

	await plugin.generateBundle.call(
		{
			emitFile: (file: { fileName: string; source: string }) => {
				if (file.fileName === "_headers") {
					source = file.source
				}

				return ""
			}
		} as never,
		{} as never,
		{} as never,
		false
	)

	return source
}

describe("web app manifest", () => {
	it("is linked from index.html", () => {
		expect(readFileSync(join(ROOT, "index.html"), "utf8")).toContain('<link rel="manifest" href="/site.webmanifest" />')
	})

	it("is allowed by the deployed CSP, and only from 'self'", async () => {
		const csp = /^ {2}Content-Security-Policy: (.+)$/m.exec(await deployedHeaders())?.[1]

		expect(csp).toBeDefined()
		expect(csp?.split("; ")).toContain("manifest-src 'self'")
	})

	it("names installable icons that exist at their stated size", () => {
		const { icons } = readManifest()

		for (const icon of icons) {
			const png = readFileSync(join(PUBLIC, icon.src))

			// IHDR width and height, big-endian, right after the 8-byte signature and the chunk's length and type.
			expect(png.subarray(1, 4).toString("latin1"), icon.src).toBe("PNG")
			expect(`${String(png.readUInt32BE(16))}x${String(png.readUInt32BE(20))}`, icon.src).toBe(icon.sizes)
		}

		// Chromium's install criteria: a 192px and a 512px icon.
		expect(icons.map(icon => icon.sizes)).toEqual(expect.arrayContaining(["192x192", "512x512"]))
	})

	it("carries the same canvas colours as index.html, theme.js and ThemeProvider", () => {
		const manifest = readManifest()
		const html = readFileSync(join(ROOT, "index.html"), "utf8")
		const script = readFileSync(join(PUBLIC, "theme.js"), "utf8")

		expect(manifest.theme_color).toBe(THEME_COLORS.light)
		expect(manifest.background_color).toBe(THEME_COLORS.light)
		// One meta, no media query: theme.js and ThemeProvider switch it to the app's theme, not the OS's.
		expect(html.match(/<meta name="theme-color"[^>]*>/g)).toEqual([`<meta name="theme-color" content="${THEME_COLORS.light}" />`])
		expect(script).toContain(`dark ? "${THEME_COLORS.dark}" : "${THEME_COLORS.light}"`)
	})
})
