import path from "node:path"

export interface AddonPathContext {
	packaged: boolean
	resourcesPath: string
	env: NodeJS.ProcessEnv
	appPath: string
	platform: NodeJS.Platform
	arch: string
	exists(file: string): boolean
}

// electron-builder's ${os}, which names the staged addon's directory.
const BUILDER_OS: Partial<Record<NodeJS.Platform, string>> = { darwin: "mac", win32: "win", linux: "linux" }

// The sync addon: shipped beside the asar when packaged; in development FILEN_DESKTOP_NAPI, else the staged copy.
// null when there is none.
export function addonPath(ctx: AddonPathContext): string | null {
	if (ctx.packaged) {
		const shipped = path.join(ctx.resourcesPath, "native", "sdk-rs.node")

		return ctx.exists(shipped) ? shipped : null
	}

	const override = ctx.env["FILEN_DESKTOP_NAPI"]

	if (override !== undefined && override.length > 0) {
		return ctx.exists(override) ? path.resolve(override) : null
	}

	const staged = path.join(ctx.appPath, "build", "native", `${BUILDER_OS[ctx.platform] ?? ctx.platform}-${ctx.arch}`, "sdk-rs.node")

	return ctx.exists(staged) ? staged : null
}
