// vite/three-assets-plugin.ts: the directories the 3D worker's Draco and Basis decoders are fetched from (same origin,
// versioned).
declare module "virtual:three-assets" {
	export const THREE_ASSETS: {
		readonly base: string
		readonly draco: string
		readonly basis: string
	}
}
