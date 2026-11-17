import { describe, expect, it } from "vitest"
import { isExecutableHead, readBinaryInfo } from "@/features/preview/lib/binaryInfo/read"
import type { BinarySource } from "@/features/preview/lib/binaryInfo/types"
import { budgetedSource } from "@/features/preview/lib/binaryInfo/budget"
import { readBinaryReading } from "@/features/preview/lib/binaryInfo/reading"

// Executables and disk images read by their headers alone, from synthetic files laid out as each format's
// specification says; truncated and hostile input gives nothing (or less), never an exception or a large read.

class Bytes {
	readonly bytes: Uint8Array
	private readonly view: DataView

	constructor(size: number) {
		this.bytes = new Uint8Array(size)
		this.view = new DataView(this.bytes.buffer)
	}

	u8(at: number, value: number): this {
		this.bytes[at] = value

		return this
	}

	u16(at: number, value: number, little = true): this {
		this.view.setUint16(at, value, little)

		return this
	}

	u32(at: number, value: number, little = true): this {
		this.view.setUint32(at, value, little)

		return this
	}

	u64(at: number, value: number, little = true): this {
		this.view.setBigUint64(at, BigInt(value), little)

		return this
	}

	ascii(at: number, text: string): this {
		for (let index = 0; index < text.length; index++) this.bytes[at + index] = text.charCodeAt(index)

		return this
	}

	utf16(at: number, text: string, little = true): this {
		for (let index = 0; index < text.length; index++) this.view.setUint16(at + index * 2, text.charCodeAt(index), little)

		return this
	}

	set(at: number, bytes: Uint8Array): this {
		this.bytes.set(bytes, at)

		return this
	}
}

// A source that records each read.
function sourceOf(bytes: Uint8Array): BinarySource & { reads: [number, number][] } {
	const reads: [number, number][] = []

	return {
		size: bytes.length,
		reads,
		read: (offset, length) => {
			reads.push([offset, length])

			return Promise.resolve(bytes.slice(Math.min(offset, bytes.length), Math.min(offset + length, bytes.length)))
		}
	}
}

// One VS_VERSIONINFO node: header, UTF-16 key, padding to 4, value, children.
function versionNode(key: string, value: Uint8Array, valueLength: number, type: number, children: Uint8Array[]): Uint8Array {
	const keyBytes = (key.length + 1) * 2
	const valueStart = (6 + keyBytes + 3) & ~3
	const childrenStart = (valueStart + value.length + 3) & ~3
	const length = childrenStart + children.reduce((sum, child) => sum + ((child.length + 3) & ~3), 0)
	const node = new Bytes(length).u16(0, length).u16(2, valueLength).u16(4, type).utf16(6, key).set(valueStart, value)
	let at = childrenStart

	for (const child of children) {
		node.set(at, child)
		at += (child.length + 3) & ~3
	}

	return node.bytes
}

function versionString(key: string, text: string): Uint8Array {
	return versionNode(key, new Bytes((text.length + 1) * 2).utf16(0, text).bytes, text.length + 1, 1, [])
}

const DER = Uint8Array.from([0x30, 0x03, 0x02, 0x01, 0x07])

// A PE32+ x86-64 GUI program: one .rsrc section holding a version resource, and a WIN_CERTIFICATE at the end.
function peFile(): Uint8Array {
	const version = versionNode("VS_VERSION_INFO", new Bytes(52).u32(0, 0xfeef04bd).bytes, 52, 0, [
		versionNode("StringFileInfo", new Uint8Array(0), 0, 1, [
			versionNode("040904b0", new Uint8Array(0), 0, 1, [
				versionString("ProductName", "Foo Setup"),
				versionString("CompanyName", "Foo Ltd"),
				versionString("FileVersion", "2.1.0.17")
			])
		])
	])
	const rsrcRaw = 0x400
	const rsrcVa = 0x1000
	// Root (type 16) at 0, name directory at 0x18, language directory at 0x30, data entry at 0x48, data at 0x60.
	const rsrc = new Bytes(0x60 + version.length)
		.u16(14, 1)
		.u32(16, 16)
		.u32(20, 0x80000000 | 0x18)
		.u16(0x18 + 14, 1)
		.u32(0x18 + 16, 1)
		.u32(0x18 + 20, 0x80000000 | 0x30)
		.u16(0x30 + 14, 1)
		.u32(0x30 + 16, 0x409)
		.u32(0x30 + 20, 0x48)
		.u32(0x48, rsrcVa + 0x60)
		.u32(0x48 + 4, version.length)
		.set(0x60, version)
	const certificateAt = rsrcRaw + rsrc.bytes.length + 8 - ((rsrcRaw + rsrc.bytes.length) % 8)
	const certificate = new Bytes(8 + DER.length)
		.u32(0, 8 + DER.length)
		.u16(4, 0x200)
		.u16(6, 2)
		.set(8, DER)
	const file = new Bytes(certificateAt + certificate.bytes.length)
	const pe = 0x80
	const optional = pe + 24

	file.ascii(0, "MZ")
		.u32(0x3c, pe)
		.ascii(pe, "PE\0\0")
		.u16(pe + 4, 0x8664)
		.u16(pe + 6, 1)
		.u32(pe + 8, 1_700_000_000)
		.u16(pe + 20, 240)
		.u16(pe + 22, 0x22)
	file.u16(optional, 0x20b)
		.u16(optional + 68, 2)
		.u32(optional + 108, 16)
	file.u32(optional + 112 + 2 * 8, rsrcVa).u32(optional + 112 + 2 * 8 + 4, rsrc.bytes.length)
	file.u32(optional + 112 + 4 * 8, certificateAt).u32(optional + 112 + 4 * 8 + 4, certificate.bytes.length)

	const section = optional + 240

	file.ascii(section, ".rsrc")
		.u32(section + 8, rsrc.bytes.length)
		.u32(section + 12, rsrcVa)
		.u32(section + 16, rsrc.bytes.length)
		.u32(section + 20, rsrcRaw)
	file.set(rsrcRaw, rsrc.bytes).set(certificateAt, certificate.bytes)

	return file.bytes
}

// A 64-bit little-endian ELF shared object with an interpreter: a position-independent executable.
function elfFile(): Uint8Array {
	const file = new Bytes(0x200)

	file.u8(0, 0x7f).ascii(1, "ELF").u8(4, 2).u8(5, 1).u8(6, 1).u8(7, 3).u16(16, 3).u16(18, 62)
	file.u64(32, 0x40).u16(54, 56).u16(56, 1)
	file.u32(0x40, 3)
		.u64(0x40 + 8, 0x100)
		.u64(0x40 + 32, 28)
	file.ascii(0x100, "/lib64/ld-linux-x86-64.so.2\0")

	return file.bytes
}

// A thin 64-bit Mach-O executable at `at`, built for macOS 11.0, with a code signature at `signatureAt` (relative).
function machOSlice(file: Bytes, at: number, cpu: number, signatureAt: number, der: Uint8Array | null): void {
	file.u32(at, 0xfeedfacf, true)
		.u32(at + 4, cpu)
		.u32(at + 12, 2)
		.u32(at + 16, 2)
		.u32(at + 20, 24 + 16)
	file.u32(at + 32, 0x32)
		.u32(at + 36, 24)
		.u32(at + 40, 1)
		.u32(at + 44, 0x000b0000)
	file.u32(at + 56, 0x1d)
		.u32(at + 60, 16)
		.u32(at + 64, signatureAt)
		.u32(at + 68, 0x200)

	const blob = at + signatureAt

	file.u32(blob, 0xfade0cc0, false)
		.u32(blob + 4, 0x200, false)
		.u32(blob + 8, 1, false)
		.u32(blob + 12, 0x10000, false)
		.u32(blob + 16, 20, false)
	file.u32(blob + 20, 0xfade0b01, false).u32(blob + 24, 8 + (der?.length ?? 0), false)

	if (der !== null) file.set(blob + 28, der)
}

function universalFile(): Uint8Array {
	const file = new Bytes(0x3000)

	file.u32(0, 0xcafebabe, false).u32(4, 2, false)
	file.u32(8, 0x0100000c, false).u32(16, 0x1000, false).u32(20, 0x800, false)
	file.u32(28, 0x01000007, false).u32(36, 0x2000, false).u32(40, 0x800, false)
	machOSlice(file, 0x1000, 0x0100000c, 0x400, DER)
	machOSlice(file, 0x2000, 0x01000007, 0x400, DER)

	return file.bytes
}

describe("readBinaryInfo", () => {
	it("reads a PE's machine, subsystem, timestamp, version strings and signature container", async () => {
		const source = sourceOf(peFile())
		const info = await readBinaryInfo(source, "setup.exe")

		expect(info).toMatchObject({
			format: "pe",
			bits: 64,
			machine: "x86-64",
			kind: "executable",
			subsystem: "Windows GUI",
			built: 1_700_000_000,
			managed: false,
			version: { productName: "Foo Setup", companyName: "Foo Ltd", fileVersion: "2.1.0.17", copyright: null },
			signature: { state: "present", der: DER }
		})
	})

	it("calls a PE with the DLL flag a library, and an unsigned one unsigned", async () => {
		const bytes = peFile()
		const view = new DataView(bytes.buffer)

		view.setUint16(0x80 + 22, 0x2022, true)
		view.setUint32(0x80 + 24 + 112 + 32, 0, true)
		view.setUint32(0x80 + 24 + 112 + 36, 0, true)

		expect(await readBinaryInfo(sourceOf(bytes), "foo.dll")).toMatchObject({ kind: "library", signature: { state: "none" } })
	})

	it("reads an ELF's class, order, type, machine, ABI and interpreter", async () => {
		expect(await readBinaryInfo(sourceOf(elfFile()), "tool")).toEqual({
			format: "elf",
			bits: 64,
			endian: "little",
			kind: "pie",
			machine: "x86-64",
			abi: "Linux",
			interpreter: "/lib64/ld-linux-x86-64.so.2"
		})
	})

	it("reads a universal Mach-O's slices, platform and code signature blob", async () => {
		expect(await readBinaryInfo(sourceOf(universalFile()), "app")).toEqual({
			format: "macho",
			slices: [
				{ cpu: "ARM64", bits: 64 },
				{ cpu: "x86-64", bits: 64 }
			],
			kind: "executable",
			platform: "macOS",
			minimumOs: "11.0",
			signature: { state: "present", der: DER }
		})
	})

	it("reads an ad hoc Mach-O signature as one without a signer", async () => {
		const file = new Bytes(0x1000)

		machOSlice(file, 0, 0x0100000c, 0x400, null)

		expect(await readBinaryInfo(sourceOf(file.bytes), "tool")).toMatchObject({ signature: { state: "present", der: null } })
	})

	it("reads a UDIF image's trailer and partition names", async () => {
		const plist =
			"<plist><dict><key>blkx</key><array><dict><key>CFName</key><string>Apple_HFS &amp; data</string><key>Name</key><string>Apple_HFS &amp; data</string></dict><dict><key>Name</key><string>Protective Master Boot Record (MBR : 0)</string></dict></array></dict></plist>"
		const file = new Bytes(0x1000 + plist.length + 512)
		const trailer = file.bytes.length - 512

		file.ascii(0x1000, plist)
			.ascii(trailer, "koly")
			.u32(trailer + 4, 4, false)
			.u64(trailer + 32, 0x1000, false)
		file.u64(trailer + 216, 0x1000, false).u64(trailer + 224, plist.length, false)

		expect(await readBinaryInfo(sourceOf(file.bytes), "disk.dmg")).toEqual({
			format: "dmg",
			encrypted: false,
			dataSize: 0x1000,
			partitions: ["Apple_HFS & data", "Protective Master Boot Record (MBR : 0)"]
		})
	})

	it("reads an ISO's primary descriptor, a Joliet volume name and an El Torito boot record", async () => {
		const file = new Bytes(32768 + 4 * 2048)
		const at = (index: number): number => 32768 + index * 2048

		file.u8(at(0), 0)
			.ascii(at(0) + 1, "CD001")
			.ascii(at(0) + 7, "EL TORITO SPECIFICATION")
		file.u8(at(1), 1)
			.ascii(at(1) + 1, "CD001")
			.ascii(at(1) + 8, "LINUX")
			.ascii(at(1) + 40, "UBUNTU_24_04")
		file.u32(at(1) + 80, 1000)
			.u16(at(1) + 128, 2048)
			.ascii(at(1) + 813, "2024042512000000")
		file.u8(at(2), 2)
			.ascii(at(2) + 1, "CD001")
			.ascii(at(2) + 88, "%/E")
			.utf16(at(2) + 40, "Ubuntu 24.04 LTS", false)
		file.u8(at(3), 255).ascii(at(3) + 1, "CD001")

		expect(await readBinaryInfo(sourceOf(file.bytes), "ubuntu.iso")).toMatchObject({
			format: "iso",
			volume: "Ubuntu 24.04 LTS",
			created: "2024-04-25 12:00:00",
			volumeBytes: 1000 * 2048,
			bootable: true,
			udf: false
		})
	})

	it("reads nothing from truncated, renamed or hostile input, without throwing", async () => {
		const pe = peFile()
		const hostile = new Bytes(0x200).ascii(0, "MZ").u32(0x3c, 0xffffff00).bytes
		const loops = new Bytes(0x1000)

		machOSlice(loops, 0, 0x0100000c, 0x400, DER)
		// A load command of size 0 ends the walk instead of looping.
		loops.u32(36, 0)

		expect(await readBinaryInfo(sourceOf(pe.subarray(0, 0x90)), "setup.exe")).toBeNull()
		expect(await readBinaryInfo(sourceOf(hostile), "x.exe")).toBeNull()
		expect(await readBinaryInfo(sourceOf(new TextEncoder().encode("just text")), "notes.exe")).toBeNull()
		expect(await readBinaryInfo(sourceOf(Uint8Array.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 0x41])), "Main.class")).toBeNull()
		expect(await readBinaryInfo(sourceOf(loops.bytes), "tool")).toMatchObject({ format: "macho" })
	})

	it("reads only a handful of small ranges", async () => {
		for (const bytes of [peFile(), elfFile(), universalFile()]) {
			const source = sourceOf(bytes)

			await readBinaryInfo(source, "file")

			expect(source.reads.length).toBeLessThanOrEqual(12)
			expect(source.reads.every(([, length]) => length <= 1024 * 1024)).toBe(true)
		}
	})
})

describe("isExecutableHead", () => {
	it("tells ELF, Mach-O and PE heads from a Java class, an MS-DOS program and text", () => {
		expect(isExecutableHead(elfFile())).toBe(true)
		expect(isExecutableHead(universalFile())).toBe(true)
		expect(isExecutableHead(peFile())).toBe(true)
		expect(isExecutableHead(Uint8Array.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 0x41]))).toBe(false)
		expect(isExecutableHead(new Bytes(0x100).ascii(0, "MZ").bytes)).toBe(false)
		expect(isExecutableHead(new TextEncoder().encode("#!/bin/sh\necho hi"))).toBe(false)
	})
})

describe("the read budget", () => {
	const MIB = 1024 * 1024

	it("lets the headers touch four distinct 1 MiB blocks, cutting a read where they end", async () => {
		const source = budgetedSource(sourceOf(new Uint8Array(8 * MIB)))

		expect((await source.read(0, 10)).length).toBe(10)
		expect((await source.read(MIB + 5, 3 * MIB)).length).toBe(3 * MIB - 5)
		expect(source.blocksTouched()).toBe(4)
		// Blocks already touched read freely; a new one does not.
		expect((await source.read(2 * MIB, 100)).length).toBe(100)
		expect((await source.read(6 * MIB, 100)).length).toBe(0)
		expect((await source.read(3 * MIB + 10, 2 * MIB)).length).toBe(MIB - 10)
	})

	// 32 slices at one offset, each with 1024 code signature commands of 4 MiB at an unaligned offset.
	it("reads a hostile universal Mach-O in a few small reads", async () => {
		const file = new Bytes(0x1000 + 0x2000 + 5 * MIB)

		file.u32(0, 0xcafebabe, false).u32(4, 32, false)

		for (let index = 0; index < 32; index++) {
			file.u32(8 + index * 20, 0x0100000c, false)
				.u32(16 + index * 20, 0x1000, false)
				.u32(20 + index * 20, 5 * MIB, false)
		}

		const slice = 0x1000

		file.u32(slice, 0xfeedfacf)
			.u32(slice + 4, 0x0100000c)
			.u32(slice + 12, 2)
			.u32(slice + 16, 1024)
			.u32(slice + 20, 1024 * 16)

		for (let command = 0; command < 1024; command++) {
			const at = slice + 32 + command * 16

			file.u32(at, 0x1d)
				.u32(at + 4, 16)
				.u32(at + 8, 0x2001)
				.u32(at + 12, 4 * MIB)
		}

		const source = sourceOf(file.bytes)
		const started = Date.now()
		const reading = await readBinaryReading(source, "app", () => null)
		const bytes = source.reads.reduce((sum, [, length]) => sum + length, 0)

		expect(reading.info).toMatchObject({ format: "macho", slices: [{ cpu: "ARM64" }] })
		// Over 1 MiB: not read, shown as unreadable.
		expect(reading.info?.format === "macho" && reading.info.signature).toEqual({ state: "unreadable" })
		expect(source.reads.length).toBeLessThanOrEqual(8)
		expect(bytes).toBeLessThanOrEqual(4 * MIB)
		expect(Date.now() - started).toBeLessThan(2000)
	})

	it("reads no ELF program header table with an impossible entry size", async () => {
		const bytes = elfFile()
		const view = new DataView(bytes.buffer)

		view.setUint16(54, 65_535, true)
		view.setUint16(56, 256, true)

		const source = sourceOf(bytes)

		expect(await readBinaryInfo(source, "tool")).toMatchObject({ format: "elf", interpreter: null })
		expect(source.reads.every(([, length]) => length <= 4096)).toBe(true)
	})

	it("sends a present signature back without its DER, with its signer", async () => {
		const reading = await readBinaryReading(sourceOf(peFile()), "setup.exe", der => ({
			subject: `CN=${String(der.length)} bytes`,
			issuer: "CN=CA",
			commonName: null,
			organization: null,
			signedAt: null
		}))

		expect(reading.signer?.subject).toBe(`CN=${String(DER.length)} bytes`)
		expect(reading.info?.format === "pe" && reading.info.signature).toEqual({ state: "present", der: new Uint8Array(0) })
	})
})
