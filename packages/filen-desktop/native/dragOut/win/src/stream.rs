//! One entry's `FileContents` stream. It is handed out at once; its first `Read` waits (in bounded steps, see
//! [`slot`](crate::slot)) for the entry's temp file, which the SDK writes whole and renames into place, then serves
//! it from disk. The file is opened with `FILE_FLAG_DELETE_ON_CLOSE`, so it is gone once the last stream (clones
//! included) is released.

use std::ffi::c_void;
use std::fs::File;
use std::os::windows::fs::FileExt;
use std::sync::{Arc, Mutex};

use windows::Win32::Foundation::{
    RPC_E_CALL_CANCELED, S_FALSE, S_OK, STG_E_ACCESSDENIED, STG_E_INVALIDFUNCTION,
    STG_E_INVALIDPOINTER, STG_E_READFAULT,
};
use windows::Win32::System::Com::{
    CoTaskMemAlloc, CoTestCancel, ISequentialStream_Impl, IStream, IStream_Impl, LOCKTYPE,
    STATFLAG, STATFLAG_NONAME, STATSTG, STGC, STGTY_STREAM, STREAM_SEEK, STREAM_SEEK_CUR,
    STREAM_SEEK_END, STREAM_SEEK_SET,
};
use windows_core::{HRESULT, PWSTR, Ref, implement};

use crate::data_object::Session;
use crate::slot::{Origin, Slot, WAIT_STEP, lock, seek};

const COPY_CHUNK: u32 = 1 << 20;

/// One `FileContents` request: shared by its stream and the stream's clones.
struct Ticket {
    session: Arc<Session>,
    id: u32,
    index: usize,
    slot: Arc<Slot>,
    file: Mutex<Option<Arc<File>>>,
}

impl Ticket {
    fn size(&self) -> u64 {
        self.session.entries[self.index].size
    }

    // Waits for the temp file on first use.
    fn file(&self) -> Result<Arc<File>, HRESULT> {
        if let Some(file) = lock(&self.file).as_ref() {
            return Ok(file.clone());
        }

        let path = self
            .slot
            .wait(WAIT_STEP, call_cancelled)
            .map_err(|_| STG_E_READFAULT)?;
        let file = self
            .session
            .open_file(&path, self.size())
            .map_err(|_| STG_E_READFAULT)?;

        Ok(lock(&self.file).get_or_insert(file).clone())
    }
}

impl Drop for Ticket {
    fn drop(&mut self) {
        self.session.registry.close(self.id);
        self.session.events.release(self.id);
    }
}

/// Whether the client cancelled the COM call this thread is serving.
fn call_cancelled() -> bool {
    // SAFETY: no arguments; outside a COM call it answers an error, read as "not cancelled".
    matches!(unsafe { CoTestCancel() }, Err(error) if error.code() == RPC_E_CALL_CANCELED)
}

fn read_exact_at(file: &File, mut out: &mut [u8], mut offset: u64) -> std::io::Result<()> {
    while !out.is_empty() {
        match file.seek_read(out, offset)? {
            0 => return Err(std::io::ErrorKind::UnexpectedEof.into()),
            read => {
                out = &mut out[read..];
                offset += read as u64;
            }
        }
    }

    Ok(())
}

#[implement(IStream)]
pub(crate) struct Stream {
    ticket: Arc<Ticket>,
    position: Mutex<u64>,
}

/// The stream for entry `index` of the session, answered through `slot`.
pub(crate) fn create(session: Arc<Session>, ticket: u32, index: usize, slot: Arc<Slot>) -> IStream {
    Stream {
        ticket: Arc::new(Ticket {
            session,
            id: ticket,
            index,
            slot,
            file: Mutex::new(None),
        }),
        position: Mutex::new(0),
    }
    .into()
}

impl Stream_Impl {
    // Reads up to `out.len()` bytes at the current position; Ok(read).
    fn read_into(&self, out: &mut [u8]) -> Result<usize, HRESULT> {
        let file = self.ticket.file()?;
        let mut position = lock(&self.position);
        let remaining = self.ticket.size().saturating_sub(*position);
        let count =
            usize::try_from(remaining).map_or(out.len(), |remaining| remaining.min(out.len()));

        read_exact_at(&file, &mut out[..count], *position).map_err(|_| STG_E_READFAULT)?;
        *position += count as u64;
        Ok(count)
    }
}

impl ISequentialStream_Impl for Stream_Impl {
    fn Read(&self, pv: *mut c_void, cb: u32, read: *mut u32) -> HRESULT {
        if pv.is_null() {
            return STG_E_INVALIDPOINTER;
        }

        // SAFETY: COM's contract: `pv` points to `cb` writable bytes for the call.
        let out = unsafe { std::slice::from_raw_parts_mut(pv.cast::<u8>(), cb as usize) };
        let (count, result) = match self.read_into(out) {
            Ok(count) if count == out.len() => (count, S_OK),
            Ok(count) => (count, S_FALSE),
            Err(error) => (0, error),
        };

        if !read.is_null() {
            // SAFETY: a non-null `pcbRead` is writable for the call; count <= cb.
            #[allow(clippy::cast_possible_truncation)]
            unsafe {
                *read = count as u32;
            }
        }

        result
    }

    fn Write(&self, _pv: *const c_void, _cb: u32, _written: *mut u32) -> HRESULT {
        STG_E_ACCESSDENIED
    }
}

impl IStream_Impl for Stream_Impl {
    fn Seek(
        &self,
        offset: i64,
        origin: STREAM_SEEK,
        new_position: *mut u64,
    ) -> windows_core::Result<()> {
        let origin = match origin {
            STREAM_SEEK_SET => Origin::Start,
            STREAM_SEEK_CUR => Origin::Current,
            STREAM_SEEK_END => Origin::End,
            _ => return Err(STG_E_INVALIDFUNCTION.into()),
        };
        let mut position = lock(&self.position);
        let target =
            seek(*position, self.ticket.size(), origin, offset).ok_or(STG_E_INVALIDFUNCTION)?;

        *position = target;
        if !new_position.is_null() {
            // SAFETY: a non-null `plibNewPosition` is writable for the call.
            unsafe { *new_position = target };
        }

        Ok(())
    }

    fn SetSize(&self, _size: u64) -> windows_core::Result<()> {
        Err(STG_E_ACCESSDENIED.into())
    }

    fn CopyTo(
        &self,
        target: Ref<IStream>,
        cb: u64,
        read: *mut u64,
        written: *mut u64,
    ) -> windows_core::Result<()> {
        let target = target.ok()?;
        let mut chunk = vec![0u8; COPY_CHUNK as usize];
        let (mut total_read, mut total_written) = (0u64, 0u64);
        let result = loop {
            let want =
                usize::try_from(cb - total_read).map_or(chunk.len(), |left| left.min(chunk.len()));

            if want == 0 {
                break Ok(());
            }

            let count = match self.read_into(&mut chunk[..want]) {
                Ok(0) => break Ok(()),
                Ok(count) => count,
                Err(error) => break Err(error.into()),
            };
            total_read += count as u64;

            let mut done = 0u32;
            // SAFETY: `chunk` holds `count` initialised bytes; `done` outlives the call.
            #[allow(clippy::cast_possible_truncation)]
            let wrote = unsafe {
                target.Write(
                    chunk.as_ptr().cast::<c_void>(),
                    count as u32,
                    Some(&raw mut done),
                )
            };
            total_written += u64::from(done);

            if let Err(error) = wrote.ok() {
                break Err(error);
            }
        };

        if !read.is_null() {
            // SAFETY: a non-null `pcbRead` is writable for the call.
            unsafe { *read = total_read };
        }
        if !written.is_null() {
            // SAFETY: a non-null `pcbWritten` is writable for the call.
            unsafe { *written = total_written };
        }

        result
    }

    fn Commit(&self, _flags: &STGC) -> windows_core::Result<()> {
        Ok(())
    }

    fn Revert(&self) -> windows_core::Result<()> {
        Err(STG_E_INVALIDFUNCTION.into())
    }

    fn LockRegion(&self, _offset: u64, _cb: u64, _lock: &LOCKTYPE) -> windows_core::Result<()> {
        Err(STG_E_INVALIDFUNCTION.into())
    }

    fn UnlockRegion(&self, _offset: u64, _cb: u64, _lock: u32) -> windows_core::Result<()> {
        Err(STG_E_INVALIDFUNCTION.into())
    }

    fn Stat(&self, stat: *mut STATSTG, flag: &STATFLAG) -> windows_core::Result<()> {
        // SAFETY: COM passes a writable STATSTG for the call, or null (refused).
        let stat = unsafe { stat.as_mut() }.ok_or(STG_E_INVALIDPOINTER)?;
        let mut name = PWSTR::null();

        if *flag != STATFLAG_NONAME {
            let entry = &self.ticket.session.entries[self.ticket.index];
            let wide: Vec<u16> = entry.name().encode_utf16().chain([0]).collect();
            // SAFETY: a plain allocation the caller frees with CoTaskMemFree, as STATSTG's contract says.
            let memory = unsafe { CoTaskMemAlloc(wide.len() * 2) }.cast::<u16>();

            if memory.is_null() {
                return Err(windows::Win32::Foundation::E_OUTOFMEMORY.into());
            }

            // SAFETY: `memory` holds wide.len() units and cannot overlap `wide`.
            unsafe { std::ptr::copy_nonoverlapping(wide.as_ptr(), memory, wide.len()) };
            name = PWSTR(memory);
        }

        #[allow(clippy::cast_sign_loss)]
        let stream_type = STGTY_STREAM.0 as u32;
        *stat = STATSTG {
            pwcsName: name,
            r#type: stream_type,
            cbSize: self.ticket.size(),
            ..STATSTG::default()
        };
        Ok(())
    }

    fn Clone(&self) -> windows_core::Result<IStream> {
        Ok(Stream {
            ticket: self.ticket.clone(),
            position: Mutex::new(*lock(&self.position)),
        }
        .into())
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::thread;
    use std::time::{Duration, Instant};

    use windows::Win32::Foundation::{S_FALSE, S_OK, STG_E_READFAULT};
    use windows::Win32::System::Com::{
        CoTaskMemFree, DVASPECT_CONTENT, FORMATETC, IStream, STATFLAG_DEFAULT, STATSTG,
        STREAM_SEEK_CUR, STREAM_SEEK_SET,
    };
    use windows::Win32::UI::Shell::CFSTR_FILECONTENTS;

    use crate::OperationResult;
    use crate::data_object::testing::{Fixture, file};
    use crate::slot::lock;

    #[allow(clippy::cast_sign_loss)]
    const ISTREAM: u32 = windows::Win32::System::Com::TYMED_ISTREAM.0 as u32;

    struct TempFile(PathBuf);

    impl TempFile {
        fn new(name: &str, bytes: &[u8]) -> Self {
            let path =
                std::env::temp_dir().join(format!("filen-drag-{}-{name}", std::process::id()));
            std::fs::write(&path, bytes).expect("write");
            Self(path)
        }
    }

    impl Drop for TempFile {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    // The entry's stream, inside a started operation.
    fn stream(fixture: &Fixture, index: i32) -> IStream {
        fixture.start();
        let cf = u16::try_from(
            // SAFETY: a static format name.
            unsafe {
                windows::Win32::System::DataExchange::RegisterClipboardFormatW(CFSTR_FILECONTENTS)
            },
        )
        .expect("format");
        let format = FORMATETC {
            cfFormat: cf,
            ptd: std::ptr::null_mut(),
            dwAspect: DVASPECT_CONTENT.0,
            lindex: index,
            tymed: ISTREAM,
        };
        // SAFETY: a live object and a FORMATETC on the stack.
        let medium = unsafe { fixture.object.GetData(&raw const format) }.expect("contents");
        // SAFETY: tymed says pstm is set; the medium's reference moves into the returned stream.
        unsafe { std::mem::ManuallyDrop::into_inner(medium.u.pstm) }.expect("stream")
    }

    fn read(stream: &IStream, cb: u32) -> (windows_core::HRESULT, Vec<u8>) {
        let mut out = vec![0u8; cb as usize];
        let mut count = 0u32;
        // SAFETY: `out` has cb writable bytes.
        let result = unsafe { stream.Read(out.as_mut_ptr().cast(), cb, Some(&raw mut count)) };
        out.truncate(count as usize);
        (result, out)
    }

    #[test]
    fn a_completed_slot_reads_back_its_bytes_then_s_false() {
        let temp = TempFile::new("read", b"hello world");
        let fixture = Fixture::new(vec![file("a.txt", 11)]);
        let stream = stream(&fixture, 0);

        assert!(
            fixture
                .registry
                .complete(fixture.last_ticket(), temp.0.clone())
        );
        assert_eq!(read(&stream, 5), (S_OK, b"hello".to_vec()));
        assert_eq!(read(&stream, 10), (S_FALSE, b" world".to_vec()));
        assert_eq!(read(&stream, 10), (S_FALSE, Vec::new()));
    }

    #[test]
    fn seek_and_clone_keep_independent_positions() {
        let temp = TempFile::new("seek", b"0123456789");
        let fixture = Fixture::new(vec![file("a", 10)]);
        let stream = stream(&fixture, 0);
        assert!(
            fixture
                .registry
                .complete(fixture.last_ticket(), temp.0.clone())
        );

        let mut at = 0u64;
        // SAFETY: in-process calls on live streams.
        unsafe { stream.Seek(4, STREAM_SEEK_SET, Some(&raw mut at)) }.expect("seek");
        assert_eq!(at, 4);
        // SAFETY: as above.
        let clone = unsafe { stream.Clone() }.expect("clone");
        assert_eq!(read(&stream, 2), (S_OK, b"45".to_vec()));
        assert_eq!(read(&clone, 3), (S_OK, b"456".to_vec()));
        // SAFETY: as above.
        unsafe { clone.Seek(-1, STREAM_SEEK_CUR, None) }.expect("seek");
        assert_eq!(read(&clone, 1), (S_OK, b"6".to_vec()));
        assert_eq!(read(&stream, 1), (S_OK, b"6".to_vec()));
        // SAFETY: as above.
        assert!(unsafe { stream.Seek(11, STREAM_SEEK_SET, None) }.is_err());

        let mut stat = STATSTG::default();
        // SAFETY: as above; the name is freed with CoTaskMemFree.
        unsafe { stream.Stat(&raw mut stat, STATFLAG_DEFAULT) }.expect("stat");
        assert_eq!(stat.cbSize, 10);
        // SAFETY: Stat returned a NUL-terminated name.
        assert_eq!(unsafe { stat.pwcsName.to_string() }.expect("name"), "a");
        // SAFETY: the caller owns the name.
        unsafe { CoTaskMemFree(Some(stat.pwcsName.0.cast())) };
    }

    #[test]
    fn end_operation_abort_unblocks_a_waiting_read_with_read_fault() {
        let fixture = Fixture::new(vec![file("a", 4)]);
        let stream = stream(&fixture, 0);
        let session = fixture.session.clone();
        let ender = thread::spawn(move || {
            thread::sleep(Duration::from_millis(100));
            session.end(OperationResult::Aborted);
        });

        let started = Instant::now();
        assert_eq!(read(&stream, 4).0, STG_E_READFAULT);
        assert!(started.elapsed() < Duration::from_secs(5));
        ender.join().expect("join");
        assert_eq!(
            lock(&fixture.recorded.ended).as_slice(),
            &[OperationResult::Aborted]
        );
    }

    #[test]
    fn a_waiting_read_notices_abort_within_one_wait() {
        let fixture = Fixture::new(vec![file("a", 4)]);
        let stream = stream(&fixture, 0);
        let registry = fixture.registry;
        let aborter = thread::spawn(move || {
            thread::sleep(Duration::from_millis(100));
            registry.abort_all();
        });

        let started = Instant::now();
        assert_eq!(read(&stream, 4).0, STG_E_READFAULT);
        assert!(started.elapsed() < super::WAIT_STEP * 4);
        aborter.join().expect("join");
    }

    #[test]
    fn a_failed_ticket_fails_its_reads() {
        let fixture = Fixture::new(vec![file("a", 4)]);
        let stream = stream(&fixture, 0);

        assert!(fixture.registry.fail(fixture.last_ticket()));
        assert_eq!(read(&stream, 4).0, STG_E_READFAULT);
    }

    #[test]
    fn a_temp_file_of_another_size_fails() {
        let temp = TempFile::new("short", b"abc");
        let fixture = Fixture::new(vec![file("a", 4)]);
        let stream = stream(&fixture, 0);

        assert!(
            fixture
                .registry
                .complete(fixture.last_ticket(), temp.0.clone())
        );
        assert_eq!(read(&stream, 4).0, STG_E_READFAULT);
    }

    #[test]
    fn the_temp_file_is_deleted_on_release() {
        let temp = TempFile::new("release", b"bytes");
        let fixture = Fixture::new(vec![file("a", 5), file("b", 5)]);
        let first = stream(&fixture, 0);
        let first_ticket = fixture.last_ticket();
        let second = stream(&fixture, 1);
        let second_ticket = fixture.last_ticket();

        // Two tickets answered with one path share the open file.
        assert!(fixture.registry.complete(first_ticket, temp.0.clone()));
        assert!(fixture.registry.complete(second_ticket, temp.0.clone()));
        assert_eq!(read(&first, 5).1, b"bytes");
        // SAFETY: an in-process call on a live stream.
        let clone = unsafe { first.Clone() }.expect("clone");
        drop(first);
        assert_eq!(read(&clone, 1).0, S_FALSE);
        assert_eq!(read(&second, 5).1, b"bytes");
        drop(second);
        assert!(temp.0.exists(), "a clone still reads it");
        drop(clone);

        assert!(!temp.0.exists());
        let released = lock(&fixture.recorded.released).clone();
        assert_eq!(released, vec![second_ticket, first_ticket]);
        assert!(!fixture.registry.complete(first_ticket, temp.0.clone()));
    }
}
