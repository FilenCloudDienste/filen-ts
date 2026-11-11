//! The drag's data object: `FileGroupDescriptorW` (prebuilt), `FileContents` (a [`stream`](crate::stream) per
//! request, only inside Explorer's async operation) and whatever the shell stores on it (`SetData`: the drag image,
//! the performed effect, the target's CLSID, ...). It lives in the addon's MTA, so every call arrives on a COM thread.

use std::collections::HashMap;
use std::ffi::c_void;
use std::fs::{File, OpenOptions};
use std::io;
use std::mem::ManuallyDrop;
use std::os::windows::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};

use windows::Win32::Foundation::{
    DATA_S_SAMEFORMATETC, DV_E_FORMATETC, DV_E_LINDEX, DV_E_TYMED, E_ABORT, E_INVALIDARG,
    E_NOTIMPL, E_OUTOFMEMORY, E_UNEXPECTED, GENERIC_READ, GlobalFree, HGLOBAL,
    OLE_E_ADVISENOTSUPPORTED, S_OK, STG_E_MEDIUMFULL,
};
use windows::Win32::Storage::FileSystem::{
    DELETE, FILE_FLAG_DELETE_ON_CLOSE, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
};
use windows::Win32::System::Com::{
    DATADIR_GET, DVASPECT_CONTENT, FORMATETC, IAdviseSink, IBindCtx, IDataObject, IDataObject_Impl,
    IEnumFORMATETC, IEnumSTATDATA, IStream, STGMEDIUM, STGMEDIUM_0, STREAM_SEEK_SET, TYMED_HGLOBAL,
    TYMED_ISTREAM,
};
use windows::Win32::System::DataExchange::RegisterClipboardFormatW;
use windows::Win32::System::Memory::{
    GMEM_MOVEABLE, GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock,
};
use windows::Win32::System::Ole::ReleaseStgMedium;
use windows::Win32::UI::Shell::{
    CFSTR_FILECONTENTS, CFSTR_FILEDESCRIPTORW, IDataObjectAsyncCapability,
    IDataObjectAsyncCapability_Impl, SHCreateMemStream, SHCreateStdEnumFmtEtc,
};
use windows_core::{BOOL, HRESULT, PCWSTR, Ref, implement};

use crate::descriptor::Entry;
use crate::slot::{Registry, lock};
use crate::{Events, OperationResult};

/// What one stored format may hold; the shell's largest is the drag image (a few MiB).
const MAX_STORED_BYTES: usize = 32 << 20;
const STORED_READ_CHUNK: u32 = 64 << 10;

#[allow(clippy::cast_sign_loss)]
const HGLOBAL_TYMED: u32 = TYMED_HGLOBAL.0 as u32;
#[allow(clippy::cast_sign_loss)]
const ISTREAM_TYMED: u32 = TYMED_ISTREAM.0 as u32;
#[allow(clippy::cast_sign_loss)]
const DATADIR_GET_U32: u32 = DATADIR_GET.0 as u32;

/// One drag: its entries and the state the data object and its streams share.
pub(crate) struct Session {
    pub(crate) id: u64,
    pub(crate) registry: &'static Registry,
    pub(crate) entries: Vec<Entry>,
    descriptor: Vec<u8>,
    cf_descriptor: u16,
    cf_contents: u16,
    async_mode: AtomicBool,
    in_operation: AtomicBool,
    started: AtomicBool,
    ended: AtomicBool,
    pub(crate) events: Box<dyn Events>,
    // Temp files open for reading, shared by every ticket answered with the same path (each opener would otherwise
    // delete it on close while another still needs it).
    files: Mutex<HashMap<PathBuf, Weak<File>>>,
}

fn clipboard_format(name: PCWSTR) -> Result<u16, String> {
    // SAFETY: `name` is a NUL-terminated string valid for the call (the SDK's static format names).
    let format = unsafe { RegisterClipboardFormatW(name) };
    u16::try_from(format)
        .ok()
        .filter(|format| *format != 0)
        .ok_or_else(|| "RegisterClipboardFormatW failed".to_owned())
}

impl Session {
    pub(crate) fn new(
        registry: &'static Registry,
        entries: Vec<Entry>,
        descriptor: Vec<u8>,
        events: Box<dyn Events>,
    ) -> Result<Arc<Self>, String> {
        Ok(Arc::new(Self {
            id: registry.session(),
            registry,
            entries,
            descriptor,
            cf_descriptor: clipboard_format(CFSTR_FILEDESCRIPTORW)?,
            cf_contents: clipboard_format(CFSTR_FILECONTENTS)?,
            async_mode: AtomicBool::new(true),
            in_operation: AtomicBool::new(false),
            started: AtomicBool::new(false),
            ended: AtomicBool::new(false),
            events,
            files: Mutex::new(HashMap::new()),
        }))
    }

    /// The target called `StartOperation`: what `InOperation` answers right after the drop.
    pub(crate) fn started(&self) -> bool {
        self.started.load(Ordering::SeqCst)
    }

    /// Explorer's operation ended: every ticket fails and JS hears it once.
    pub(crate) fn end(&self, result: OperationResult) {
        if self.ended.swap(true, Ordering::SeqCst) {
            return;
        }

        self.in_operation.store(false, Ordering::SeqCst);
        self.registry.abort_session(self.id);
        self.events.operation_end(result);
    }

    /// The entry's whole temp file, opened so it is deleted once the last reader closes it.
    pub(crate) fn open_file(&self, path: &Path, size: u64) -> io::Result<Arc<File>> {
        let mut files = lock(&self.files);
        files.retain(|_, file| file.strong_count() > 0);

        if let Some(file) = files.get(path).and_then(Weak::upgrade) {
            return Ok(file);
        }

        let file = OpenOptions::new()
            .access_mode(GENERIC_READ.0 | DELETE.0)
            .share_mode(FILE_SHARE_READ.0 | FILE_SHARE_WRITE.0 | FILE_SHARE_DELETE.0)
            .custom_flags(FILE_FLAG_DELETE_ON_CLOSE.0)
            .open(path)?;

        if file.metadata()?.len() != size {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "the temp file's size differs from the entry's",
            ));
        }

        let file = Arc::new(file);
        files.insert(path.to_owned(), Arc::downgrade(&file));
        Ok(file)
    }
}

impl Drop for Session {
    // The object went away mid-operation (Explorer died): COM's rundown released it without an EndOperation.
    fn drop(&mut self) {
        if self.started() {
            self.end(OperationResult::Failed);
        }

        self.registry.forget_session(self.id);
    }
}

/// A format the shell stored with `SetData`, kept as bytes so it can be handed out any number of times.
struct Stored {
    format: u16,
    aspect: u32,
    lindex: i32,
    tymed: u32,
    bytes: Vec<u8>,
}

#[implement(IDataObject, IDataObjectAsyncCapability)]
pub(crate) struct DataObject {
    session: Arc<Session>,
    stored: Mutex<Vec<Stored>>,
}

impl DataObject {
    pub(crate) fn new(session: Arc<Session>) -> Self {
        Self {
            session,
            stored: Mutex::new(Vec::new()),
        }
    }
}

fn hglobal_medium(bytes: &[u8]) -> windows_core::Result<STGMEDIUM> {
    // SAFETY: a plain allocation; the handle is checked by `?`.
    let handle = unsafe { GlobalAlloc(GMEM_MOVEABLE, bytes.len().max(1)) }?;
    // SAFETY: `handle` is the movable block just allocated.
    let pointer = unsafe { GlobalLock(handle) };

    if pointer.is_null() {
        let error = windows_core::Error::from_thread();
        // SAFETY: the block is ours, unlocked and handed to no one; its result is the error already returned.
        let _ = unsafe { GlobalFree(Some(handle)) };
        return Err(error);
    }

    // SAFETY: the locked block holds at least `bytes.len()` bytes and cannot overlap a Rust slice.
    unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), pointer.cast::<u8>(), bytes.len()) };
    // SAFETY: balances the GlobalLock above; its "not locked anymore" error is the expected result.
    let _ = unsafe { GlobalUnlock(handle) };

    Ok(STGMEDIUM {
        tymed: HGLOBAL_TYMED,
        u: STGMEDIUM_0 { hGlobal: handle },
        pUnkForRelease: ManuallyDrop::new(None),
    })
}

fn hglobal_bytes(handle: HGLOBAL) -> windows_core::Result<Vec<u8>> {
    // SAFETY: the caller's medium holds a valid HGLOBAL for the call's duration.
    let size = unsafe { GlobalSize(handle) };

    if size > MAX_STORED_BYTES {
        return Err(STG_E_MEDIUMFULL.into());
    }

    if size == 0 {
        return Ok(Vec::new());
    }

    // SAFETY: as above.
    let pointer = unsafe { GlobalLock(handle) };

    if pointer.is_null() {
        return Err(windows_core::Error::from_thread());
    }

    // SAFETY: the locked block is `size` bytes long and stays valid until GlobalUnlock.
    let bytes = unsafe { std::slice::from_raw_parts(pointer.cast::<u8>(), size) }.to_vec();
    // SAFETY: balances the GlobalLock above.
    let _ = unsafe { GlobalUnlock(handle) };
    Ok(bytes)
}

fn stream_bytes(stream: &IStream) -> windows_core::Result<Vec<u8>> {
    // From the start, whatever the caller's position; a stream that cannot seek is read from where it is.
    // SAFETY: a valid stream the caller lent for the call.
    let _ = unsafe { stream.Seek(0, STREAM_SEEK_SET, None) };
    let mut bytes = Vec::new();
    let mut chunk = vec![0u8; STORED_READ_CHUNK as usize];

    loop {
        let mut read = 0u32;
        // SAFETY: `chunk` has STORED_READ_CHUNK writable bytes and `read` outlives the call.
        unsafe {
            stream.Read(
                chunk.as_mut_ptr().cast::<c_void>(),
                STORED_READ_CHUNK,
                Some(&raw mut read),
            )
        }
        .ok()?;

        if read == 0 {
            return Ok(bytes);
        }

        if bytes.len() + read as usize > MAX_STORED_BYTES {
            return Err(STG_E_MEDIUMFULL.into());
        }

        bytes.extend_from_slice(&chunk[..read as usize]);
    }
}

fn format_of(format: u16, aspect: u32, lindex: i32, tymed: u32) -> FORMATETC {
    FORMATETC {
        cfFormat: format,
        ptd: std::ptr::null_mut(),
        dwAspect: aspect,
        lindex,
        tymed,
    }
}

impl DataObject_Impl {
    fn contents(&self, format: &FORMATETC) -> windows_core::Result<STGMEDIUM> {
        let session = &self.session;

        if format.tymed & ISTREAM_TYMED == 0 {
            return Err(DV_E_TYMED.into());
        }

        let index = usize::try_from(format.lindex).map_err(|_| DV_E_LINDEX)?;
        let entry = session.entries.get(index).ok_or(DV_E_LINDEX)?;

        // A sync-only target (or a request outside Explorer's async operation) would block a COM call on a download.
        if entry.directory || !session.in_operation.load(Ordering::SeqCst) {
            return Err(DV_E_FORMATETC.into());
        }

        // Refused once the session ended, also when EndOperation ran since the check above.
        let (ticket, slot) = session.registry.open(session.id).ok_or(E_ABORT)?;
        // Created before JS hears of the ticket, so an immediate answer finds the slot alive.
        let stream = crate::stream::create(session.clone(), ticket, index, slot);
        let queued = u32::try_from(index).is_ok_and(|index| session.events.contents(ticket, index));

        if !queued {
            session.registry.fail(ticket);
        }

        Ok(STGMEDIUM {
            tymed: ISTREAM_TYMED,
            u: STGMEDIUM_0 {
                pstm: ManuallyDrop::new(Some(stream)),
            },
            pUnkForRelease: ManuallyDrop::new(None),
        })
    }

    fn stored_medium(&self, format: &FORMATETC) -> windows_core::Result<STGMEDIUM> {
        let stored = lock(&self.stored);
        let Some(found) = stored
            .iter()
            .find(|stored| stored.format == format.cfFormat)
        else {
            return Err(DV_E_FORMATETC.into());
        };

        if format.tymed & found.tymed == 0 {
            return Err(DV_E_TYMED.into());
        }

        if found.tymed == HGLOBAL_TYMED {
            return hglobal_medium(&found.bytes);
        }

        // SAFETY: SHCreateMemStream copies the bytes into a new stream.
        let stream = unsafe { SHCreateMemStream(Some(&found.bytes)) }.ok_or(E_OUTOFMEMORY)?;
        Ok(STGMEDIUM {
            tymed: ISTREAM_TYMED,
            u: STGMEDIUM_0 {
                pstm: ManuallyDrop::new(Some(stream)),
            },
            pUnkForRelease: ManuallyDrop::new(None),
        })
    }
}

impl IDataObject_Impl for DataObject_Impl {
    fn GetData(&self, format: *const FORMATETC) -> windows_core::Result<STGMEDIUM> {
        // SAFETY: COM hands a FORMATETC valid for the call, or null (refused).
        let format = unsafe { format.as_ref() }.ok_or(E_INVALIDARG)?;
        let session = &self.session;

        if format.cfFormat == session.cf_descriptor {
            if format.tymed & HGLOBAL_TYMED == 0 {
                return Err(DV_E_TYMED.into());
            }

            return hglobal_medium(&session.descriptor);
        }

        if format.cfFormat == session.cf_contents {
            return self.contents(format);
        }

        self.stored_medium(format)
    }

    fn GetDataHere(
        &self,
        _format: *const FORMATETC,
        _medium: *mut STGMEDIUM,
    ) -> windows_core::Result<()> {
        Err(E_NOTIMPL.into())
    }

    fn QueryGetData(&self, format: *const FORMATETC) -> HRESULT {
        // SAFETY: as in GetData.
        let Some(format) = (unsafe { format.as_ref() }) else {
            return E_INVALIDARG;
        };
        let session = &self.session;
        let tymed = if format.cfFormat == session.cf_descriptor {
            Some(HGLOBAL_TYMED)
        } else if format.cfFormat == session.cf_contents {
            Some(ISTREAM_TYMED)
        } else {
            lock(&self.stored)
                .iter()
                .find(|stored| stored.format == format.cfFormat)
                .map(|stored| stored.tymed)
        };

        match tymed {
            None => DV_E_FORMATETC,
            Some(tymed) if format.tymed & tymed == 0 => DV_E_TYMED,
            Some(_) => S_OK,
        }
    }

    fn GetCanonicalFormatEtc(&self, format: *const FORMATETC, out: *mut FORMATETC) -> HRESULT {
        // SAFETY: COM passes both pointers valid for the call, or null (refused).
        let (Some(format), Some(out)) = (unsafe { format.as_ref() }, unsafe { out.as_mut() })
        else {
            return E_INVALIDARG;
        };

        *out = *format;
        out.ptd = std::ptr::null_mut();
        DATA_S_SAMEFORMATETC
    }

    fn SetData(
        &self,
        format: *const FORMATETC,
        medium: *const STGMEDIUM,
        release: BOOL,
    ) -> windows_core::Result<()> {
        // SAFETY: COM passes both pointers valid for the call, or null (refused).
        let (Some(format), Some(given)) = (unsafe { format.as_ref() }, unsafe { medium.as_ref() })
        else {
            return Err(E_INVALIDARG.into());
        };
        let session = &self.session;

        if format.cfFormat == session.cf_descriptor || format.cfFormat == session.cf_contents {
            return Err(DV_E_FORMATETC.into());
        }

        let bytes = match given.tymed {
            // SAFETY: `tymed` says which union member is set.
            HGLOBAL_TYMED => hglobal_bytes(unsafe { given.u.hGlobal })?,
            // SAFETY: as above.
            ISTREAM_TYMED => match unsafe { &*given.u.pstm } {
                Some(stream) => stream_bytes(stream)?,
                None => return Err(E_INVALIDARG.into()),
            },
            _ => return Err(DV_E_TYMED.into()),
        };

        {
            let mut stored = lock(&self.stored);
            stored.retain(|stored| stored.format != format.cfFormat);
            stored.push(Stored {
                format: format.cfFormat,
                aspect: format.dwAspect,
                lindex: format.lindex,
                tymed: given.tymed,
                bytes,
            });
        }

        // Owned on success only: a failed SetData leaves the medium to the caller.
        if release.as_bool() {
            // SAFETY: with fRelease the caller handed the medium over; it is released exactly once, here.
            unsafe { ReleaseStgMedium(medium.cast_mut()) };
        }

        Ok(())
    }

    fn EnumFormatEtc(&self, direction: u32) -> windows_core::Result<IEnumFORMATETC> {
        if direction != DATADIR_GET_U32 {
            return Err(E_NOTIMPL.into());
        }

        let session = &self.session;
        let mut formats = vec![
            format_of(session.cf_descriptor, DVASPECT_CONTENT.0, -1, HGLOBAL_TYMED),
            format_of(session.cf_contents, DVASPECT_CONTENT.0, -1, ISTREAM_TYMED),
        ];
        formats.extend(
            lock(&self.stored)
                .iter()
                .map(|stored| format_of(stored.format, stored.aspect, stored.lindex, stored.tymed)),
        );

        // SAFETY: the enumerator copies the slice.
        unsafe { SHCreateStdEnumFmtEtc(&formats) }
    }

    fn DAdvise(
        &self,
        _format: *const FORMATETC,
        _advf: u32,
        _sink: Ref<IAdviseSink>,
    ) -> windows_core::Result<u32> {
        Err(OLE_E_ADVISENOTSUPPORTED.into())
    }

    fn DUnadvise(&self, _connection: u32) -> windows_core::Result<()> {
        Err(OLE_E_ADVISENOTSUPPORTED.into())
    }

    fn EnumDAdvise(&self) -> windows_core::Result<IEnumSTATDATA> {
        Err(OLE_E_ADVISENOTSUPPORTED.into())
    }
}

impl IDataObjectAsyncCapability_Impl for DataObject_Impl {
    fn SetAsyncMode(&self, async_mode: BOOL) -> windows_core::Result<()> {
        self.session
            .async_mode
            .store(async_mode.as_bool(), Ordering::SeqCst);
        Ok(())
    }

    fn GetAsyncMode(&self) -> windows_core::Result<BOOL> {
        Ok(self.session.async_mode.load(Ordering::SeqCst).into())
    }

    fn StartOperation(&self, _reserved: Ref<IBindCtx>) -> windows_core::Result<()> {
        let session = &self.session;

        if session.ended.load(Ordering::SeqCst) {
            return Err(E_UNEXPECTED.into());
        }

        session.in_operation.store(true, Ordering::SeqCst);
        session.started.store(true, Ordering::SeqCst);
        Ok(())
    }

    fn InOperation(&self) -> windows_core::Result<BOOL> {
        Ok(self.session.in_operation.load(Ordering::SeqCst).into())
    }

    fn EndOperation(
        &self,
        result: HRESULT,
        _reserved: Ref<IBindCtx>,
        _effects: u32,
    ) -> windows_core::Result<()> {
        self.session.end(OperationResult::from_hresult(
            result.is_ok(),
            result == E_ABORT,
        ));
        Ok(())
    }
}

#[cfg(test)]
pub(crate) mod testing {
    use std::sync::{Arc, Mutex};

    use windows::Win32::System::Com::{COINIT_MULTITHREADED, CoInitializeEx, IDataObject};
    use windows::Win32::UI::Shell::IDataObjectAsyncCapability;
    use windows_core::Interface;

    use super::{DataObject, Session};
    use crate::descriptor::{self, Entry};
    use crate::slot::{Registry, lock};
    use crate::{Events, OperationResult};

    #[derive(Default)]
    pub(crate) struct Recorded {
        pub(crate) contents: Mutex<Vec<(u32, u32)>>,
        pub(crate) released: Mutex<Vec<u32>>,
        pub(crate) ended: Mutex<Vec<OperationResult>>,
    }

    pub(crate) struct Recording(pub(crate) Arc<Recorded>);

    impl Events for Recording {
        fn contents(&self, ticket: u32, index: u32) -> bool {
            lock(&self.0.contents).push((ticket, index));
            true
        }

        fn release(&self, ticket: u32) {
            lock(&self.0.released).push(ticket);
        }

        fn operation_end(&self, result: OperationResult) {
            lock(&self.0.ended).push(result);
        }
    }

    pub(crate) fn mta() {
        // SAFETY: entering the MTA on a test thread; repeated calls only add a reference.
        unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }
            .ok()
            .expect("CoInitializeEx");
    }

    pub(crate) fn file(path: &str, size: u64) -> Entry {
        Entry {
            path: path.to_owned(),
            directory: false,
            size,
            mtime_ms: None,
        }
    }

    pub(crate) struct Fixture {
        pub(crate) registry: &'static Registry,
        pub(crate) session: Arc<Session>,
        pub(crate) object: IDataObject,
        pub(crate) recorded: Arc<Recorded>,
    }

    impl Fixture {
        pub(crate) fn new(entries: Vec<Entry>) -> Self {
            mta();
            let registry: &'static Registry = Box::leak(Box::new(Registry::new()));
            let recorded = Arc::new(Recorded::default());
            let descriptor = descriptor::build(&entries).expect("descriptor");
            let session = Session::new(
                registry,
                entries,
                descriptor,
                Box::new(Recording(recorded.clone())),
            )
            .expect("session");
            let object: IDataObject = DataObject::new(session.clone()).into();

            Self {
                registry,
                session,
                object,
                recorded,
            }
        }

        pub(crate) fn start(&self) {
            let capability: IDataObjectAsyncCapability =
                self.object.cast().expect("async capability");
            // SAFETY: an in-process call on a live object.
            unsafe { capability.StartOperation(None) }.expect("StartOperation");
        }

        pub(crate) fn last_ticket(&self) -> u32 {
            lock(&self.recorded.contents)
                .last()
                .expect("a contents call")
                .0
        }
    }
}

#[cfg(test)]
mod tests {
    use std::mem::ManuallyDrop;

    use windows::Win32::Foundation::{DV_E_FORMATETC, DV_E_LINDEX, S_OK};
    use windows::Win32::System::Com::{
        DVASPECT_CONTENT, IDataObject, IStream, STGMEDIUM, STGMEDIUM_0,
    };
    use windows::Win32::System::Ole::ReleaseStgMedium;
    use windows::Win32::UI::Shell::{
        FILEDESCRIPTORW, IDataObjectAsyncCapability, SHCreateMemStream,
    };
    use windows_core::{HSTRING, Interface, PCWSTR};

    use super::testing::{Fixture, file};
    use super::{
        DATADIR_GET_U32, HGLOBAL_TYMED, ISTREAM_TYMED, clipboard_format, format_of, hglobal_bytes,
        hglobal_medium, stream_bytes,
    };
    use crate::descriptor::{self, DESCRIPTOR_SIZE, Entry};
    use crate::slot::lock;
    use crate::{OperationResult, mta};

    fn get(
        object: &IDataObject,
        format: u16,
        lindex: i32,
        tymed: u32,
    ) -> windows_core::Result<STGMEDIUM> {
        let format = format_of(format, DVASPECT_CONTENT.0, lindex, tymed);
        // SAFETY: a live object and a FORMATETC on the stack.
        unsafe { object.GetData(&raw const format) }
    }

    fn take_hglobal(mut medium: STGMEDIUM) -> Vec<u8> {
        assert_eq!(medium.tymed, HGLOBAL_TYMED);
        // SAFETY: tymed says hGlobal is set.
        let bytes = hglobal_bytes(unsafe { medium.u.hGlobal }).expect("bytes");
        // SAFETY: the medium was handed to the test.
        unsafe { ReleaseStgMedium(&raw mut medium) };
        bytes
    }

    #[test]
    fn descriptor_layout_matches_the_shell_format() {
        assert_eq!(size_of::<FILEDESCRIPTORW>(), DESCRIPTOR_SIZE);
        assert_eq!(
            core::mem::offset_of!(FILEDESCRIPTORW, dwFlags),
            descriptor::OFFSET_FLAGS
        );
        assert_eq!(
            core::mem::offset_of!(FILEDESCRIPTORW, dwFileAttributes),
            descriptor::OFFSET_ATTRIBUTES
        );
        assert_eq!(
            core::mem::offset_of!(FILEDESCRIPTORW, ftLastWriteTime),
            descriptor::OFFSET_WRITE_TIME
        );
        assert_eq!(
            core::mem::offset_of!(FILEDESCRIPTORW, nFileSizeHigh),
            descriptor::OFFSET_SIZE_HIGH
        );
        assert_eq!(
            core::mem::offset_of!(FILEDESCRIPTORW, nFileSizeLow),
            descriptor::OFFSET_SIZE_LOW
        );
        assert_eq!(
            core::mem::offset_of!(FILEDESCRIPTORW, cFileName),
            descriptor::OFFSET_NAME
        );

        let entry = Entry {
            path: "dir\\a.txt".to_owned(),
            directory: false,
            size: (3u64 << 32) | 9,
            mtime_ms: Some(0.0),
        };
        let bytes = descriptor::build(std::slice::from_ref(&entry)).expect("descriptor");
        // SAFETY: `bytes` holds one FILEDESCRIPTORW (packed, 592 bytes) after the count.
        let parsed = unsafe {
            bytes
                .as_ptr()
                .add(4)
                .cast::<FILEDESCRIPTORW>()
                .read_unaligned()
        };
        // Packed fields are copied out before comparing (no references into a packed struct).
        let (flags, high, low, written, file_name) = (
            parsed.dwFlags,
            parsed.nFileSizeHigh,
            parsed.nFileSizeLow,
            parsed.ftLastWriteTime,
            parsed.cFileName,
        );

        assert_eq!(flags, descriptor::flags(&entry));
        assert_eq!((high, low), (3, 9));
        assert_eq!(
            (u64::from(written.dwHighDateTime) << 32) | u64::from(written.dwLowDateTime),
            116_444_736_000_000_000
        );
        let name: Vec<u16> = "dir\\a.txt".encode_utf16().collect();
        assert_eq!(&file_name[..name.len()], name.as_slice());
        assert_eq!(file_name[name.len()], 0);
    }

    #[test]
    fn descriptor_round_trips_through_get_data() {
        let entries = vec![file("a.txt", 5), file("b.txt", 6)];
        let want = descriptor::build(&entries).expect("descriptor");
        let fixture = Fixture::new(entries);
        let session = fixture.session.clone();
        // Through the addon's MTA and a proxy, as DoDragDrop gets it.
        let proxy = mta::marshal(move || super::DataObject::new(session).into()).expect("marshal");
        let cf =
            clipboard_format(windows::Win32::UI::Shell::CFSTR_FILEDESCRIPTORW).expect("format");

        assert_eq!(
            take_hglobal(get(&proxy, cf, -1, HGLOBAL_TYMED).expect("descriptor")),
            want
        );
        assert_eq!(
            take_hglobal(get(&fixture.object, cf, -1, HGLOBAL_TYMED).expect("descriptor")),
            want
        );
    }

    #[test]
    fn set_data_round_trips_private_formats() {
        let fixture = Fixture::new(vec![file("a", 1)]);
        let object = &fixture.object;
        let private_name = HSTRING::from("FilenDragTest");
        let streamed_name = HSTRING::from("FilenDragTestStream");
        let private = clipboard_format(PCWSTR(private_name.as_ptr())).expect("format");
        let streamed = clipboard_format(PCWSTR(streamed_name.as_ptr())).expect("format");

        // An HGLOBAL handed over (fRelease): the object frees it.
        let format = format_of(private, DVASPECT_CONTENT.0, -1, HGLOBAL_TYMED);
        let medium = hglobal_medium(&[1, 2, 3]).expect("medium");
        // SAFETY: a live object; with fRelease it owns the medium afterwards.
        unsafe { object.SetData(&raw const format, &raw const medium, true) }.expect("SetData");
        assert_eq!(
            take_hglobal(get(object, private, -1, HGLOBAL_TYMED).expect("stored")),
            vec![1, 2, 3]
        );
        // SAFETY: a live object.
        assert_eq!(unsafe { object.QueryGetData(&raw const format) }, S_OK);

        // A stream lent (no fRelease): copied, handed out as a new stream.
        // SAFETY: copies the bytes.
        let stream = unsafe { SHCreateMemStream(Some(&[7, 8])) }.expect("stream");
        let format = format_of(streamed, DVASPECT_CONTENT.0, -1, ISTREAM_TYMED);
        let mut lent = STGMEDIUM {
            tymed: ISTREAM_TYMED,
            u: STGMEDIUM_0 {
                pstm: ManuallyDrop::new(Some(stream)),
            },
            pUnkForRelease: ManuallyDrop::new(None),
        };
        // SAFETY: a live object; without fRelease the medium stays ours.
        unsafe { object.SetData(&raw const format, &raw const lent, false) }.expect("SetData");
        // SAFETY: still ours: releases the stream once.
        unsafe { ReleaseStgMedium(&raw mut lent) };
        let mut handed = get(object, streamed, -1, ISTREAM_TYMED).expect("stored");
        // SAFETY: tymed says pstm is set.
        let copy: &IStream = unsafe { handed.u.pstm.as_ref() }.expect("stream");
        assert_eq!(stream_bytes(copy).expect("bytes"), vec![7, 8]);
        // SAFETY: the medium was handed to the test.
        unsafe { ReleaseStgMedium(&raw mut handed) };

        // Both are enumerated after ours.
        // SAFETY: a live object.
        let formats = unsafe { object.EnumFormatEtc(DATADIR_GET_U32) }.expect("enum");
        let mut listed = [format_of(0, 0, 0, 0); 8];
        let mut count = 0u32;
        // SAFETY: room for 8 entries.
        let _ = unsafe { formats.Next(&mut listed, Some(&raw mut count)) };
        let listed: Vec<u16> = listed[..count as usize]
            .iter()
            .map(|f| f.cfFormat)
            .collect();
        assert_eq!(listed.len(), 4);
        assert_eq!(&listed[2..], &[private, streamed]);
    }

    #[test]
    fn ours_cannot_be_overwritten() {
        let fixture = Fixture::new(vec![file("a", 1)]);
        let cf =
            clipboard_format(windows::Win32::UI::Shell::CFSTR_FILEDESCRIPTORW).expect("format");
        let format = format_of(cf, DVASPECT_CONTENT.0, -1, HGLOBAL_TYMED);
        let medium = hglobal_medium(&[0]).expect("medium");
        let mut medium = medium;

        // SAFETY: a live object; a refused SetData leaves the medium to us.
        let refused = unsafe {
            fixture
                .object
                .SetData(&raw const format, &raw const medium, true)
        };
        assert_eq!(refused.map_err(|error| error.code()), Err(DV_E_FORMATETC));
        // SAFETY: still ours.
        unsafe { ReleaseStgMedium(&raw mut medium) };
    }

    #[test]
    fn file_contents_is_refused_before_start_operation() {
        let fixture = Fixture::new(vec![
            Entry {
                path: "dir".to_owned(),
                directory: true,
                size: 0,
                mtime_ms: None,
            },
            file("dir\\a", 3),
        ]);
        let cf = clipboard_format(windows::Win32::UI::Shell::CFSTR_FILECONTENTS).expect("format");
        let code = |lindex| {
            get(&fixture.object, cf, lindex, ISTREAM_TYMED)
                .map(|_| ())
                .map_err(|e| e.code())
        };

        assert_eq!(code(1), Err(DV_E_FORMATETC));
        assert!(lock(&fixture.recorded.contents).is_empty());

        fixture.start();
        assert_eq!(code(0), Err(DV_E_FORMATETC), "a directory has no contents");
        assert_eq!(code(2), Err(DV_E_LINDEX));
        assert_eq!(code(-1), Err(DV_E_LINDEX));
        let mut medium = get(&fixture.object, cf, 1, ISTREAM_TYMED).expect("stream");
        assert_eq!(medium.tymed, ISTREAM_TYMED);
        assert_eq!(
            lock(&fixture.recorded.contents).as_slice(),
            &[(fixture.last_ticket(), 1)]
        );
        // SAFETY: the medium was handed to the test.
        unsafe { ReleaseStgMedium(&raw mut medium) };
        assert_eq!(
            lock(&fixture.recorded.released).as_slice(),
            &[fixture.last_ticket()]
        );
    }

    #[test]
    fn end_operation_reports_once_and_refuses_later_contents() {
        let fixture = Fixture::new(vec![file("a", 3)]);
        let capability: IDataObjectAsyncCapability =
            fixture.object.cast().expect("async capability");
        let cf = clipboard_format(windows::Win32::UI::Shell::CFSTR_FILECONTENTS).expect("format");

        fixture.start();
        assert!(fixture.session.started());
        // SAFETY: in-process calls on a live object.
        unsafe { capability.EndOperation(windows::Win32::Foundation::E_ABORT, None, 0) }
            .expect("EndOperation");
        // SAFETY: as above.
        unsafe { capability.EndOperation(S_OK, None, 0) }.expect("EndOperation");
        assert_eq!(
            lock(&fixture.recorded.ended).as_slice(),
            &[OperationResult::Aborted]
        );
        // SAFETY: as above.
        let in_operation = unsafe { capability.InOperation() }.expect("InOperation");
        assert!(!in_operation.as_bool());
        assert!(get(&fixture.object, cf, 0, ISTREAM_TYMED).is_err());
        assert!(
            fixture.registry.open(fixture.session.id).is_some(),
            "only this session ended"
        );
    }

    #[test]
    fn a_session_gone_mid_operation_reports_failed() {
        let fixture = Fixture::new(vec![file("a", 3)]);
        let recorded = fixture.recorded.clone();

        fixture.start();
        drop(fixture);
        assert_eq!(lock(&recorded.ended).as_slice(), &[OperationResult::Failed]);
    }
}
