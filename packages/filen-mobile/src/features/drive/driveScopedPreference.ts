import type { DrivePath } from "@/hooks/useDrivePath"

// Persisted drive preference that is either one global value or a value per directory.
export type ScopedPreferences<T> = {
	mode: "global" | "perDirectory"
	global: T
	perDirectory: Record<string, T>
}

export function getPerDirectoryKey(drivePath: DrivePath): string {
	return `${drivePath.type ?? ""}:${drivePath.uuid ?? ""}`
}

export function applyScopedPreference<T>(prev: ScopedPreferences<T>, key: string, next: T): ScopedPreferences<T> {
	if (prev.mode === "perDirectory") {
		return {
			...prev,
			perDirectory: {
				...prev.perDirectory,
				[key]: next
			}
		}
	}

	return {
		...prev,
		global: next
	}
}
