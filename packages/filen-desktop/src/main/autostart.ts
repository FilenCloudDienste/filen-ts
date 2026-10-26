import { mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"

// Linux has no login-item API; desktop environments start what an XDG autostart entry names.
// https://specifications.freedesktop.org/autostart-spec/latest/

export function autostartFile(configHome: string | undefined, home: string): string {
	return path.join(
		configHome !== undefined && configHome.length > 0 ? configHome : path.join(home, ".config"),
		"autostart",
		"Filen.desktop"
	)
}

// Exec quoting from the Desktop Entry spec: an argument with reserved characters is double-quoted with ", `, $ and \
// backslash-escaped; the value as a whole then gets string escaping (\ doubled) and % doubled (field codes).
function execArg(arg: string): string {
	return /^[\w/.,:+=@-]+$/.test(arg) ? arg : `"${arg.replace(/["`$\\]/g, character => `\\${character}`)}"`
}

export function autostartEntry(command: readonly string[]): string {
	const exec = command.map(execArg).join(" ").replace(/\\/g, "\\\\").replace(/%/g, "%%")

	return [
		"[Desktop Entry]",
		"Type=Application",
		"Name=Filen",
		`Exec=${exec}`,
		"Terminal=false",
		"X-GNOME-Autostart-enabled=true",
		""
	].join("\n")
}

export async function setAutostart(file: string, command: readonly string[] | null): Promise<void> {
	if (command === null) {
		await rm(file, { force: true })

		return
	}

	await mkdir(path.dirname(file), { recursive: true })
	await writeFile(file, autostartEntry(command))
}
