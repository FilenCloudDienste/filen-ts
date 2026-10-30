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

// A file of build/native/<os>-<arch>: shipped beside the asar when packaged, else the staged copy. null when there is none.
export function nativeFilePath(ctx: Omit<AddonPathContext, "env">, file: string): string | null {
	const candidate = ctx.packaged
		? path.join(ctx.resourcesPath, "native", file)
		: path.join(ctx.appPath, "build", "native", `${BUILDER_OS[ctx.platform] ?? ctx.platform}-${ctx.arch}`, file)

	return ctx.exists(candidate) ? candidate : null
}

// The sync addon; in development FILEN_DESKTOP_NAPI takes precedence over the staged copy.
export function addonPath(ctx: AddonPathContext): string | null {
	const override = ctx.env["FILEN_DESKTOP_NAPI"]

	if (!ctx.packaged && override !== undefined && override.length > 0) {
		return ctx.exists(override) ? path.resolve(override) : null
	}

	return nativeFilePath(ctx, "sdk-rs.node")
}
