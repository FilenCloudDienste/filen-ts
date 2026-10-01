// DUAL-SURFACE (see project memory "SDK-rs dual surface"): a SharingRole reaches JS in one of three
// shapes, and readers must not assume the one their generated type names.
// - The wasm runtime: the Rust enum is internally tagged (`#[serde(tag = "type", rename_all =
//   "camelCase")]`), so it arrives flat as `{ type: "sharer" | "receiver", email, id }`. The published
//   wasm `.d.ts` still types it as the externally-tagged `{ Sharer: ShareInfo } | { Receiver: ShareInfo }`,
//   which no runtime value has.
// - The uniffi runtime: `{ tag: "Sharer" | "Receiver", inner: [ShareInfo] }`.
// - The `.d.ts` shape itself, which test fixtures still build.
// SharingRoleLike widens every carrier to optional so the readers below take whichever is present,
// without importing either surface's generated SharingRole/ShareInfo type. ShareInfo.id is a Rust u64:
// a number or a bigint depending on the surface, so id below accepts either.
interface ShareInfoLike {
	id: number | bigint
	email: string
}

export interface SharingRoleLike {
	type?: string
	email?: string
	id?: number | bigint
	tag?: string
	inner?: readonly ShareInfoLike[]
	Sharer?: ShareInfoLike
	Receiver?: ShareInfoLike
}

// The OTHER party's identity for a shared item: a bigint user id (BigInt-normalized — an
// un-normalized number id would never match a `Set<bigint>` block-list key, silently leaking a
// blocked user's shared item) plus their email.
export interface ShareIdentity {
	userId: bigint
	email: string
}

// Which party the role names — always the OTHER one: "sharer" on an item shared with the user,
// "receiver" on an item the user shared out.
export type ShareRoleKind = "sharer" | "receiver"

export function shareRoleKind(role: SharingRoleLike | undefined): ShareRoleKind | null {
	if (role === undefined) {
		return null
	}

	if (role.type === "sharer" || role.tag === "Sharer" || role.Sharer !== undefined) {
		return "sharer"
	}

	if (role.type === "receiver" || role.tag === "Receiver" || role.Receiver !== undefined) {
		return "receiver"
	}

	return null
}

// Reads the OTHER party's identity out of a SharingRole value, whichever shape it carries (see
// SharingRoleLike above). Callers pass their own generated SharingRole value directly.
export function shareIdentityFromRole(role: SharingRoleLike | undefined): ShareIdentity | null {
	const flat = role?.email !== undefined && role.id !== undefined ? { id: role.id, email: role.email } : undefined
	const info = flat ?? role?.inner?.[0] ?? role?.Sharer ?? role?.Receiver

	return info === undefined ? null : { userId: BigInt(info.id), email: info.email }
}
