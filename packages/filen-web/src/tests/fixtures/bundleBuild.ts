import { join } from "node:path"
import { build, mergeConfig, type InlineConfig, type Plugin, type PluginOption } from "vite"

// A production `vite build` of the app's config (unminified, nothing written) for the bundle-shape tests, with the
// asset plugins reduced to their virtual modules. Their build work (cargo builds of the spellchecker and encoding
// detector, the dictionary and OCR model downloads, the diagram frame's own build, hashing and gzipping every asset)
// says nothing about a bundle's code and would make the unit suite need Rust and the network; the URLs those modules
// give stay the build's own hashed ones wherever they come from a committed manifest.

const PACKAGE_DIR = join(import.meta.dirname, "../../..")
const ASSET_PLUGINS = new Set([
	"filen:sdk-artifacts",
	"filen:office-fonts",
	"filen:office-hyphenation",
	"filen:spellcheck-assets",
	"filen:encoding-detect",
	"filen:pdfjs-assets",
	"filen:three-assets",
	"filen:ocr-assets",
	"filen:mermaid-frame"
])

export interface BundleFile {
	readonly type: string
	readonly fileName: string
	readonly code?: string
}

async function flatten(option: PluginOption): Promise<Plugin[]> {
	const resolved = await option

	if (Array.isArray(resolved)) {
		return (await Promise.all(resolved.map(flatten))).flat()
	}

	return typeof resolved === "object" && resolved !== null ? [resolved] : []
}

function modulesOnly(plugin: Plugin): Plugin {
	const kept: Plugin = { name: plugin.name }

	if (plugin.configResolved !== undefined) kept.configResolved = plugin.configResolved
	if (plugin.resolveId !== undefined) kept.resolveId = plugin.resolveId
	if (plugin.load !== undefined) kept.load = plugin.load

	return kept
}

async function testPlugins(options: readonly PluginOption[]): Promise<Plugin[]> {
	const plugins = (await Promise.all(options.map(flatten))).flat()
	const missing = [...ASSET_PLUGINS].filter(name => !plugins.some(plugin => plugin.name === name))

	if (missing.length > 0) throw new Error(`not in the Vite config: ${missing.join(", ")}`)

	const reduced = plugins.map(plugin => (ASSET_PLUGINS.has(plugin.name) ? modulesOnly(plugin) : plugin))
	// A new asset plugin doing work at build start belongs in ASSET_PLUGINS.
	const working = reduced.filter(plugin => plugin.name.startsWith("filen:") && plugin.buildStart !== undefined)

	if (working.length > 0) throw new Error(`asset work at build start: ${working.map(plugin => plugin.name).join(", ")}`)

	return reduced
}

export async function bundleBuild(overrides: InlineConfig): Promise<BundleFile[]> {
	const factory = (await import("../../../vite.config")).default
	const config = factory({ mode: "production", command: "build", isSsrBuild: false, isPreview: false })
	const result: unknown = await build(
		mergeConfig<InlineConfig, InlineConfig>(
			{ ...config, plugins: await testPlugins(config.plugins ?? []), root: PACKAGE_DIR, configFile: false, logLevel: "silent" },
			mergeConfig<InlineConfig, InlineConfig>({ build: { write: false, minify: false } }, overrides)
		)
	)
	const outputs = (Array.isArray(result) ? result : [result]) as { readonly output: readonly BundleFile[] }[]

	return outputs.flatMap(output => output.output)
}

// One worker entry under src/features/pdf/workers/, built into one module as the app builds it.
export function workerBuild(worker: string): Promise<BundleFile[]> {
	return bundleBuild({
		build: {
			rolldownOptions: {
				input: join(PACKAGE_DIR, "src/features/pdf/workers", worker),
				output: { format: "es", codeSplitting: false }
			}
		}
	})
}

export function bundleCode(files: readonly BundleFile[]): string {
	return files
		.filter(file => file.type === "chunk")
		.map(file => file.code ?? "")
		.join("\n")
}
