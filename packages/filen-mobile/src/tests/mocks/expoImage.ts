/**
 * Minimal expo-image mock for Vitest.
 *
 * The real expo-image can't load in the node test env — it imports expo-modules-core,
 * which references native globals (`__DEV__`, `ExpoGlobal`) at module-evaluation time and
 * throws on import. Tests whose import chain reaches expo-image (setup.ts's disk-cache
 * configuration; audioCache's cover-art extraction, pulled into auth.ts) mock it with this.
 *
 * Only the static `Image` methods that callers actually invoke are stubbed — no component.
 */
export const Image = {
	configureCache: (_config: { maxDiskSize?: number; maxMemoryCost?: number; maxMemoryCount?: number }): void => {},
	clearMemoryCache: async (): Promise<boolean> => true,
	clearDiskCache: async (): Promise<boolean> => true,
	prefetch: async (): Promise<boolean> => true,
	getCachePathAsync: async (): Promise<string | null> => null,
	loadAsync: async (): Promise<null> => null,
	generateBlurhashAsync: async (): Promise<string | null> => null
}
