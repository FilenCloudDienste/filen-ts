// "preview" namespace, text family — an executable's or disk image's headers. Spread into preview.ts; same catalog rules.
export const previewTextBinary = {
	/** Binary info — the subtitle: a kind with its format details; {{kind}} is one of the kinds below, {{detail}} e.g. "PE32+, x86-64" */
	previewBinaryKindDetail: "{{kind}} ({{detail}})",
	/** Binary info — kind: a Windows program */
	previewBinaryPeExecutable: "Windows executable",
	/** Binary info — kind: a Windows library (DLL) */
	previewBinaryPeLibrary: "Windows library",
	/** Binary info — kind: a Windows driver */
	previewBinaryPeDriver: "Windows driver",
	/** Binary info — kind: a UEFI program or driver */
	previewBinaryPeEfi: "EFI program",
	/** Binary info — kind: an ELF program */
	previewBinaryElfExecutable: "ELF executable",
	/** Binary info — kind: an ELF position-independent program */
	previewBinaryElfPie: "ELF executable (position-independent)",
	/** Binary info — kind: an ELF shared library */
	previewBinaryElfSharedObject: "ELF shared library",
	/** Binary info — kind: an ELF object file */
	previewBinaryElfRelocatable: "ELF object file",
	/** Binary info — kind: an ELF core dump */
	previewBinaryElfCore: "ELF core dump",
	/** Binary info — kind: another ELF file */
	previewBinaryElfOther: "ELF file",
	/** Binary info — kind: an Apple (Mach-O) program */
	previewBinaryMachOExecutable: "Mach-O executable",
	/** Binary info — kind: an Apple (Mach-O) library */
	previewBinaryMachOLibrary: "Mach-O library",
	/** Binary info — kind: an Apple (Mach-O) bundle */
	previewBinaryMachOBundle: "Mach-O bundle",
	/** Binary info — kind: an Apple (Mach-O) object file */
	previewBinaryMachOObject: "Mach-O object file",
	/** Binary info — kind: an Apple kernel extension */
	previewBinaryMachOKernelExtension: "Kernel extension",
	/** Binary info — kind: another Mach-O file */
	previewBinaryMachOOther: "Mach-O file",
	/** Binary info — detail: a universal (multi-architecture) Mach-O; {{architectures}} lists them */
	previewBinaryUniversal: "universal: {{architectures}}",
	/** Binary info — kind: an Apple disk image */
	previewBinaryDmg: "Apple disk image",
	/** Binary info — kind: a CD/DVD image */
	previewBinaryIso: "Disc image",
	/** Binary info — field: the Windows subsystem it runs under */
	previewBinarySubsystem: "Subsystem",
	/** Binary info — field: when it was built, from the header's timestamp */
	previewBinaryBuilt: "Built",
	/** Binary info — the built date's source; {{date}} is formatted */
	previewBinaryBuiltValue: "{{date}} (header timestamp)",
	/** Binary info — field: the signature's state */
	previewBinarySignature: "Signature",
	/** Binary info — the file has a signature, which is not checked */
	previewBinarySignaturePresent: "Present (not verified)",
	/** Binary info — the file has a signature whose container could not be read */
	previewBinarySignatureUnreadable: "Present (unreadable)",
	/** Binary info — a Mach-O signature with no signer (ad hoc) */
	previewBinarySignatureAdHoc: "Present (ad hoc, no signer)",
	/** Binary info — the file has no signature */
	previewBinarySignatureNone: "None",
	/** Binary info — field: who signed it (the certificate's subject) */
	previewBinarySigner: "Signed by",
	/** Binary info — field: who issued the signer's certificate */
	previewBinaryIssuer: "Issued by",
	/** Binary info — field: when it was signed, as the signature claims */
	previewBinarySigned: "Signed",
	/** Binary info — field: the product it belongs to */
	previewBinaryProduct: "Product",
	/** Binary info — field: the company that made it */
	previewBinaryCompany: "Company",
	/** Binary info — field: its description */
	previewBinaryDescription: "Description",
	/** Binary info — field: its file version */
	previewBinaryFileVersion: "File version",
	/** Binary info — field: its product version */
	previewBinaryProductVersion: "Product version",
	/** Binary info — field: its copyright line */
	previewBinaryCopyright: "Copyright",
	/** Binary info — field: the file name it was built as */
	previewBinaryOriginalName: "Original name",
	/** Binary info — field: whether it is a .NET assembly */
	previewBinaryManaged: ".NET assembly",
	/** Binary info — field: its byte order */
	previewBinaryByteOrder: "Byte order",
	/** Binary info — byte order: little-endian */
	previewBinaryLittleEndian: "Little-endian",
	/** Binary info — byte order: big-endian */
	previewBinaryBigEndian: "Big-endian",
	/** Binary info — field: the ABI it was built for */
	previewBinaryAbi: "ABI",
	/** Binary info — field: the dynamic loader it asks for */
	previewBinaryInterpreter: "Interpreter",
	/** Binary info — field: the platform and minimum OS version it was built for */
	previewBinaryPlatform: "Requires",
	/** Binary info — the platform's minimum version; {{platform}} (macOS) and {{version}} (11.0) */
	previewBinaryPlatformValue: "{{platform}} {{version}} or later",
	/** Binary info — field: whether the disk image is encrypted */
	previewBinaryEncrypted: "Encrypted",
	/** Binary info — field: the disk image's data size */
	previewBinaryDataSize: "Data size",
	/** Binary info — field: the disk image's partitions */
	previewBinaryPartitions: "Partitions",
	/** Binary info — field: the disc's volume label */
	previewBinaryVolume: "Volume",
	/** Binary info — field: the system the disc was made for */
	previewBinarySystem: "System",
	/** Binary info — field: the disc's publisher */
	previewBinaryPublisher: "Publisher",
	/** Binary info — field: the application that made the disc */
	previewBinaryApplication: "Made with",
	/** Binary info — field: when the disc was made, as written in it */
	previewBinaryCreated: "Created",
	/** Binary info — field: the volume's size */
	previewBinaryVolumeSize: "Volume size",
	/** Binary info — field: whether the disc can boot */
	previewBinaryBootable: "Bootable",
	/** Binary info — field: whether the disc has a UDF file system */
	previewBinaryUdf: "UDF",
	/** Binary info — a yes value */
	previewBinaryYes: "Yes",
	/** Binary info — a no value */
	previewBinaryNo: "No",
	/** Binary info — the card's footer */
	previewBinaryNeverRun: "Never run. Read from the file's headers only.",
	/** Binary info — the file's headers are no executable or disk image this reads */
	previewBinaryUnreadable: "This file is no executable or disk image this preview reads.",
	/** Binary info — reading the headers failed */
	previewBinaryFailed: "The file's headers could not be read."
}
