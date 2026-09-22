// DUAL-SURFACE (see project memory "SDK-rs dual surface"): the SDK's wasm `.d.ts` types SharingRole
// as the externally-tagged `{ Sharer: ShareInfo } | { Receiver: ShareInfo }`, but a uniffi-style
// runtime instead surfaces a `{ tag, inner: [ShareInfo] }` shape. SharingRoleLike widens every
// possible carrier to optional so shareIdentityFromRole reads whichever is actually present, without
// importing either surface's generated SharingRole/ShareInfo type. ShareInfo.id is `number` on the
// wasm .d.ts but `bigint` at the uniffi runtime — id below accepts either.
interface ShareInfoLike {
	id: number | bigint
	email: string
}

export interface SharingRoleLike {
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

// Reads the OTHER party's identity out of a SharingRole value, whichever of the two SDK surfaces'
// runtime shapes it actually carries (see SharingRoleLike above). Callers pass their own generated
// SharingRole value directly — it is structurally assignable to SharingRoleLike on both surfaces.
export function shareIdentityFromRole(role: SharingRoleLike | undefined): ShareIdentity | null {
	if (role === undefined) {
		return null
	}

	const inner = role.inner

	if (inner !== undefined && inner.length > 0) {
		const first = inner[0]

		if (first !== undefined) {
			return { userId: BigInt(first.id), email: first.email }
		}
	}

	const info = role.Sharer ?? role.Receiver ?? null

	if (info === null) {
		return null
	}

	return { userId: BigInt(info.id), email: info.email }
}
