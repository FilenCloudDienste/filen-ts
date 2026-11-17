// What an executable or disk image says about itself in its headers, read without running or mounting anything.

// Random reads of the file (a ByteReader): past the end they come back short.
export interface BinarySource {
	readonly size: number
	read(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array>
}

export type BinarySignature =
	| { readonly state: "none" }
	// The CMS SignedData as embedded, unverified; null for a Mach-O signature without a signer (ad hoc).
	| { readonly state: "present"; readonly der: Uint8Array | null }
	// A signature is there, but its container could not be read.
	| { readonly state: "unreadable" }

// VS_VERSIONINFO's strings.
export interface PeVersion {
	readonly productName: string | null
	readonly companyName: string | null
	readonly fileDescription: string | null
	readonly fileVersion: string | null
	readonly productVersion: string | null
	readonly copyright: string | null
	readonly originalFilename: string | null
}

export interface PeInfo {
	readonly format: "pe"
	readonly bits: 32 | 64
	readonly machine: string
	readonly kind: "executable" | "library" | "driver" | "efi"
	readonly subsystem: string | null
	// The header's timestamp (seconds), when it is a plausible date; reproducible builds put a hash there.
	readonly built: number | null
	readonly version: PeVersion | null
	readonly signature: BinarySignature
	// A .NET assembly (it has a CLR header).
	readonly managed: boolean
}

export interface ElfInfo {
	readonly format: "elf"
	readonly bits: 32 | 64
	readonly endian: "little" | "big"
	readonly kind: "executable" | "pie" | "sharedObject" | "relocatable" | "core" | "other"
	readonly machine: string
	readonly abi: string
	// The program interpreter (PT_INTERP): the dynamic loader it asks for.
	readonly interpreter: string | null
}

export interface MachOSlice {
	readonly cpu: string
	readonly bits: 32 | 64
}

export interface MachOInfo {
	readonly format: "macho"
	readonly slices: readonly MachOSlice[]
	readonly kind: "executable" | "library" | "bundle" | "object" | "kernelExtension" | "other"
	// The platform and minimum version it was built for (LC_BUILD_VERSION, LC_VERSION_MIN_*).
	readonly platform: string | null
	readonly minimumOs: string | null
	readonly signature: BinarySignature
}

export interface DmgInfo {
	readonly format: "dmg"
	readonly encrypted: boolean
	// Bytes of the image's data fork, unpacked size unknown.
	readonly dataSize: number | null
	readonly partitions: readonly string[]
}

export interface IsoInfo {
	readonly format: "iso"
	readonly volume: string | null
	readonly system: string | null
	readonly publisher: string | null
	readonly application: string | null
	// As written in the descriptor: YYYY-MM-DD HH:MM:SS, its zone not applied.
	readonly created: string | null
	readonly volumeBytes: number | null
	readonly bootable: boolean
	readonly udf: boolean
}

export type BinaryInfo = PeInfo | ElfInfo | MachOInfo | DmgInfo | IsoInfo
