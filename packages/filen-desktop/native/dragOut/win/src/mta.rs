//! The addon's multithreaded apartment: one thread, started on the first drag, that entered the MTA and stays for the
//! life of the process. A data object marshalled from it is called on COM's RPC threads, never on the (blocked) main
//! thread, and the apartment outlives `DoDragDrop`, so Explorer keeps extracting after `begin` returned.

use std::ffi::c_void;
use std::mem::ManuallyDrop;
use std::sync::OnceLock;
use std::sync::mpsc::{self, Sender};
use std::thread;

use windows::Win32::System::Com::Marshal::CoMarshalInterThreadInterfaceInStream;
use windows::Win32::System::Com::StructuredStorage::CoGetInterfaceAndReleaseStream;
use windows::Win32::System::Com::{COINIT_MULTITHREADED, CoInitializeEx, IDataObject, IStream};
use windows_core::Interface;

type Job = Box<dyn FnOnce() + Send>;

static MTA: OnceLock<Result<Sender<Job>, String>> = OnceLock::new();

fn start() -> Result<Sender<Job>, String> {
    let (jobs, queue) = mpsc::channel::<Job>();
    let (entered, outcome) = mpsc::channel::<Result<(), String>>();

    thread::Builder::new()
        .name("filen-drag-mta".to_owned())
        .spawn(move || {
            // SAFETY: the first COM call on this new thread; it never leaves the apartment.
            let result = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
            let failed = result.is_err();
            let _ = entered.send(if failed {
                Err(format!("CoInitializeEx failed: {result:?}"))
            } else {
                Ok(())
            });

            if !failed {
                // The sender lives in a static: this runs until the process ends.
                for job in queue {
                    job();
                }
            }
        })
        .map_err(|error| error.to_string())?;

    outcome.recv().map_err(|error| error.to_string())??;
    Ok(jobs)
}

/// Runs `job` on the MTA thread and waits for its result.
fn run<T: Send + 'static>(job: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    let jobs = MTA.get_or_init(start).as_ref().map_err(Clone::clone)?;
    let (done, result) = mpsc::channel();

    jobs.send(Box::new(move || {
        let _ = done.send(job());
    }))
    .map_err(|error| error.to_string())?;
    result.recv().map_err(|error| error.to_string())
}

// A marshalled stream crossing to the caller's thread; only its address travels.
struct Marshalled(usize);

/// Creates the object in the MTA and returns it unmarshalled into the caller's apartment (a proxy from an STA).
pub(crate) fn marshal(
    create: impl FnOnce() -> IDataObject + Send + 'static,
) -> Result<IDataObject, String> {
    let marshalled = run(move || {
        let object = create();
        // SAFETY: marshals a live interface of this (MTA) thread into a new stream.
        unsafe { CoMarshalInterThreadInterfaceInStream(&IDataObject::IID, &object) }
            .map(|stream| Marshalled(stream.into_raw() as usize))
            .map_err(|error| format!("CoMarshalInterThreadInterfaceInStream failed: {error}"))
    })??;

    // SAFETY: the address is the stream `into_raw` gave up above, owned by nobody else. ManuallyDrop: the call below
    // releases it, also when it fails.
    let stream = ManuallyDrop::new(unsafe { IStream::from_raw(marshalled.0 as *mut c_void) });
    // SAFETY: the stream holds one marshalled IDataObject for this process.
    unsafe { CoGetInterfaceAndReleaseStream(&*stream) }
        .map_err(|error| format!("CoGetInterfaceAndReleaseStream failed: {error}"))
}
