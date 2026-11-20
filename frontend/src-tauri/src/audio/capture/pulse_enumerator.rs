// Persistent, single-threaded PulseAudio enumerator (TECH-02).
//
// Instead of opening and destroying two fresh libpulse connections every
// 2 seconds for the entire duration of a meeting, this module owns exactly
// one `Mainloop` + `Context` pair on a dedicated OS thread named `pulse-enum`.
// All device enumeration requests (`list_sinks`, `list_sources`,
// `default_source_name`) are sent to that thread, executed sequentially, and
// answered back on a bounded-time channel.
//
// This is the only structurally correct way to share a libpulse mainloop:
// `libpulse_binding::mainloop::standard::Mainloop` contains an `Rc`, so it is
// `!Send` and `!Sync`. A single owner thread + message passing therefore both
// satisfies the libpulse threading contract and removes the continuous
// connect/disconnect churn that multiplied the crash surface observed in
// TECH-02.

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context as _, Result};
use libpulse_binding::callbacks::ListResult;
use libpulse_binding::context::introspect::ServerInfo;
use libpulse_binding::context::{Context, FlagSet as ContextFlagSet, State as ContextState};
use libpulse_binding::mainloop::standard::{IterateResult, Mainloop};
use libpulse_binding::operation::{Operation, State as OperationState};
use libpulse_binding::proplist::Proplist;
use log::{debug, info, warn};

use super::pulse_linux::{PulseSink, PulseSource};

#[derive(Debug)]
pub(crate) struct PulseListError;

impl std::fmt::Display for PulseListError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("PulseAudio device list callback failed")
    }
}

impl std::error::Error for PulseListError {}

fn collect_list_result<T, U>(
    result: ListResult<T>,
    entries: &mut std::result::Result<Vec<U>, PulseListError>,
    map: impl FnOnce(T) -> Option<U>,
) {
    match result {
        ListResult::Item(value) => {
            if let Ok(entries) = entries {
                if let Some(entry) = map(value) {
                    entries.push(entry);
                }
            }
        }
        ListResult::Error => *entries = Err(PulseListError),
        ListResult::End => {}
    }
}

#[cfg(test)]
mod list_result_tests {
    use super::*;

    #[test]
    fn end_without_items_is_a_successful_empty_inventory() {
        let mut entries = Ok(Vec::<i32>::new());
        collect_list_result(ListResult::<i32>::End, &mut entries, Some);
        assert_eq!(entries.unwrap(), Vec::<i32>::new());
    }

    #[test]
    fn successful_items_preserve_order_and_filtered_items_are_omitted() {
        let mut entries = Ok(Vec::new());
        for value in [3, 0, 1] {
            collect_list_result(ListResult::Item(value), &mut entries, |value| {
                (value != 0).then_some(value)
            });
        }
        collect_list_result(ListResult::<i32>::End, &mut entries, Some);
        assert_eq!(entries.unwrap(), vec![3, 1]);
    }

    #[test]
    fn error_without_items_is_not_an_empty_inventory() {
        let mut entries = Ok(Vec::<i32>::new());
        collect_list_result(ListResult::<i32>::Error, &mut entries, Some);
        assert!(entries.is_err());
    }

    #[test]
    fn partial_inventory_is_discarded_and_failure_is_sticky() {
        let mut entries = Ok(Vec::new());
        collect_list_result(ListResult::Item(1), &mut entries, Some);
        collect_list_result(ListResult::<i32>::Error, &mut entries, Some);
        collect_list_result(ListResult::Item(2), &mut entries, |_| {
            panic!("a failed inventory must not map later items")
        });
        collect_list_result(ListResult::<i32>::End, &mut entries, Some);
        let error = entries
            .map_err(anyhow::Error::from)
            .context("Failed to list PulseAudio sources")
            .unwrap_err();
        assert!(error.is::<PulseListError>());
    }
}

/// Upper bound on any single mainloop pumping loop. A local introspection
/// round-trip answers in milliseconds; this is a safety ceiling against a
/// server that accepts the connection and then never answers (which would
/// otherwise wedge the enumerator thread forever), not an expected duration.
const PULSE_OP_TIMEOUT: Duration = Duration::from_secs(5);

/// Time the caller waits for a response from the enumerator thread. Slightly
/// larger than `PULSE_OP_TIMEOUT` so a slow-but-successful operation is not
/// aborted on the caller side.
const CALLER_TIMEOUT: Duration = Duration::from_secs(7);

/// Requests the enumerator thread can serve. One variant per introspection
/// call we actually need — deliberately not a generic "run this closure",
/// because closures over libpulse types are not `Send`.
enum Request {
    ListSinks(mpsc::Sender<Result<Vec<PulseSink>>>),
    ListSources(mpsc::Sender<Result<Vec<PulseSource>>>),
    DefaultSourceName(mpsc::Sender<Result<Option<String>>>),
    DefaultSinkName(mpsc::Sender<Result<Option<String>>>),
}

/// Sender to the single enumerator thread. Created lazily on first use and
/// kept for the lifetime of the process.
struct QueuedRequest {
    request: Request,
    deadline: Instant,
}

static ENUMERATOR: Mutex<Option<mpsc::SyncSender<QueuedRequest>>> = Mutex::new(None);

// Struct fields drop in declaration order, including during unwinding.
// The context retains a raw pointer into the mainloop API.
struct Connection {
    context: Context,
    mainloop: Mainloop,
}

fn enqueue(request: Request) -> Result<()> {
    let mut owner = ENUMERATOR.lock().unwrap_or_else(|e| e.into_inner());
    if owner.is_none() {
        // Creation, nonblocking enqueue and failed-worker removal share one lock.
        // A stale sender's failure must never remove a newer worker's owner.
        let (tx, rx) = mpsc::sync_channel(8);
        thread::Builder::new()
            .name("pulse-enum".into())
            .spawn(move || enumerator_thread(rx))
            .map_err(|e| anyhow!("Failed to spawn pulse-enum thread: {}", e))?;
        *owner = Some(tx);
    }
    let result = owner.as_ref().unwrap().try_send(QueuedRequest {
        request, deadline: Instant::now() + PULSE_OP_TIMEOUT,
    });
    if matches!(result, Err(mpsc::TrySendError::Disconnected(_))) {
        // A crashed worker must not poison enumeration for the process lifetime.
        *owner = None;
    }
    result.map_err(|e| anyhow!("PulseAudio enumerator is busy or unavailable: {}", e))
}

fn enumerator_thread(receiver: mpsc::Receiver<QueuedRequest>) {
    let mut connection: Option<Connection> = None;

    for QueuedRequest { request, deadline } in receiver {
        if Instant::now() >= deadline {
            send_error(request, anyhow!("PulseAudio enumeration request expired"));
            continue;
        }
        // Reconnect lazily if we have no connection or if the existing one died.
        let mut needs_connect = connection.is_none();
        if let Some(Connection { ref context, .. }) = connection {
            if context.get_state() != ContextState::Ready {
                warn!(
                    "pulse_enumerator: context state is {:?}, reconnecting",
                    context.get_state()
                );
                needs_connect = true;
            }
        }

        if needs_connect {
            drop(connection.take());

            match connect(deadline) {
                Ok(conn) => {
                    info!("pulse_enumerator: connected to PulseAudio/PipeWire server");
                    connection = Some(conn);
                }
                Err(e) => {
                    warn!("pulse_enumerator: failed to connect: {}", e);
                    send_error(request, e);
                    continue;
                }
            }
        }

        // `connection` is guaranteed `Some` and `Ready` here.
        let Connection { mainloop, context } = connection.as_mut().expect("connection set above");

        let failed = match request {
            Request::ListSinks(reply) => {
                let result = list_sinks_impl(mainloop, context, deadline);
                let failed = result.is_err();
                let _ = reply.send(result);
                failed
            }
            Request::ListSources(reply) => {
                let result = list_sources_impl(mainloop, context, deadline);
                let failed = result.is_err();
                let _ = reply.send(result);
                failed
            }
            Request::DefaultSourceName(reply) => {
                let result = default_name_impl(mainloop, context, deadline, |info| {
                    info.default_source_name.as_deref().map(str::to_string)
                });
                let failed = result.is_err();
                let _ = reply.send(result);
                failed
            }
            Request::DefaultSinkName(reply) => {
                let result = default_name_impl(mainloop, context, deadline, |info| {
                    info.default_sink_name.as_deref().map(str::to_string)
                });
                let failed = result.is_err();
                let _ = reply.send(result);
                failed
            }
        };
        // A timed-out operation is not a healthy connection. Reconnect on the
        // next request instead of repeatedly querying the same wedged context.
        if failed {
            drop(connection.take());
        }
    }

}

/// Helper for early connection failures where we still need to reply to the
/// caller with the error.
fn send_error(request: Request, error: anyhow::Error) {
    match request {
        Request::ListSinks(reply) => {
            let _ = reply.send(Err(error));
        }
        Request::ListSources(reply) => {
            let _ = reply.send(Err(error));
        }
        Request::DefaultSourceName(reply) | Request::DefaultSinkName(reply) => {
            let _ = reply.send(Err(error));
        }
    }
}

/// Connect a context to the default PulseAudio/PipeWire server, blocking until
/// it's ready or the safety timeout fires.
fn connect(deadline: Instant) -> Result<Connection> {
    let mut mainloop =
        Mainloop::new().ok_or_else(|| anyhow!("Failed to create PulseAudio mainloop"))?;

    let proplist =
        Proplist::new().ok_or_else(|| anyhow!("Failed to create PulseAudio proplist"))?;
    let mut context = Context::new_with_proplist(&mainloop, "Meetily", &proplist)
        .ok_or_else(|| anyhow!("Failed to create PulseAudio context"))?;

    context
        .connect(None, ContextFlagSet::NOAUTOSPAWN, None)
        .map_err(|e| anyhow!("Failed to connect to PulseAudio/PipeWire server: {}", e))?;

    loop {
        if Instant::now() > deadline {
            return Err(anyhow!(
                "PulseAudio/PipeWire connection timed out after {:?}",
                PULSE_OP_TIMEOUT
            ));
        }

        match mainloop.iterate(false) {
            IterateResult::Quit(_) | IterateResult::Err(_) => {
                return Err(anyhow!(
                    "PulseAudio mainloop iteration failed while connecting"
                ));
            }
            IterateResult::Success(0) => thread::sleep(Duration::from_millis(5)),
            IterateResult::Success(_) => {}
        }

        match context.get_state() {
            ContextState::Ready => break,
            ContextState::Failed | ContextState::Terminated => {
                return Err(anyhow!(
                    "PulseAudio/PipeWire context connection failed or was terminated"
                ));
            }
            _ => {}
        }
    }

    Ok(Connection { context, mainloop })
}

/// Pump the mainloop until `operation` finishes, with a safety timeout.
fn run_operation_to_completion<T: ?Sized>(
    mainloop: &mut Mainloop,
    operation: &mut Operation<T>,
    deadline: Instant,
) -> Result<()> {
    loop {
        if Instant::now() > deadline {
            operation.cancel();
            return Err(anyhow!(
                "PulseAudio/PipeWire operation timed out after {:?}",
                PULSE_OP_TIMEOUT
            ));
        }

        // Nonblocking pumping makes the deadline effective even on a silent
        // server. Cancel before dropping callback ownership on every failure.
        match mainloop.iterate(false) {
            IterateResult::Quit(_) | IterateResult::Err(_) => {
                operation.cancel();
                return Err(anyhow!("PulseAudio mainloop iteration failed"));
            }
            IterateResult::Success(0) => thread::sleep(Duration::from_millis(5)),
            IterateResult::Success(_) => {}
        }

        match operation.get_state() {
            OperationState::Done => return Ok(()),
            OperationState::Cancelled => {
                return Err(anyhow!("PulseAudio operation was cancelled"));
            }
            OperationState::Running => continue,
        }
    }
}

fn list_sinks_impl(mainloop: &mut Mainloop, context: &Context, deadline: Instant) -> Result<Vec<PulseSink>> {
    let sinks = Rc::new(RefCell::new(Ok(Vec::new())));
    let sinks_cb = sinks.clone();

    let mut operation = context.introspect().get_sink_info_list(move |result| {
        collect_list_result(result, &mut sinks_cb.borrow_mut(), |info| {
            let monitor_source_name = info.monitor_source_name.as_deref().unwrap_or_default();
            if monitor_source_name.is_empty() {
                return None;
            }

            let description = info
                .description
                .as_deref()
                .unwrap_or("Unknown output")
                .to_string();

            Some(PulseSink {
                name: info.name.as_deref().unwrap_or_default().to_string(),
                description,
                monitor_source_name: monitor_source_name.to_string(),
            })
        });
    });

    let operation_result = run_operation_to_completion(mainloop, &mut operation, deadline);
    drop(operation);

    let result = sinks
        .replace(Ok(Vec::new()))
        .map_err(anyhow::Error::from)
        .context("Failed to list PulseAudio sinks")?;
    operation_result?;
    Ok(result)
}

fn microphone_port_usable(availability: Option<libpulse_binding::def::PortAvailable>) -> bool {
    availability != Some(libpulse_binding::def::PortAvailable::No)
}

#[cfg(test)]
mod port_tests {
    use super::*;
    use libpulse_binding::def::PortAvailable;
    #[test]
    fn only_explicit_unavailability_excludes_a_microphone() {
        assert!(!microphone_port_usable(Some(PortAvailable::No)));
        assert!(microphone_port_usable(Some(PortAvailable::Yes)));
        assert!(microphone_port_usable(Some(PortAvailable::Unknown)));
        assert!(microphone_port_usable(None));
    }
}

fn list_sources_impl(mainloop: &mut Mainloop, context: &Context, deadline: Instant) -> Result<Vec<PulseSource>> {
    let sources = Rc::new(RefCell::new(Ok(Vec::new())));
    let sources_cb = sources.clone();

    let mut operation = context.introspect().get_source_info_list(move |result| {
        collect_list_result(result, &mut sources_cb.borrow_mut(), |info| {
            // Monitors of sinks are already exposed as "System Audio" devices
            // through list_sinks(); ignore them here.
            if info.monitor_of_sink.is_some() {
                return None;
            }
            if !microphone_port_usable(info.active_port.as_ref().map(|port| port.available)) {
                return None;
            }

            let source_name = info.name.as_deref().unwrap_or_default();
            if source_name.is_empty() {
                return None;
            }

            let description = info
                .description
                .as_deref()
                .unwrap_or(source_name)
                .to_string();

            Some(PulseSource {
                description,
                source_name: source_name.to_string(),
            })
        });
    });

    let operation_result = run_operation_to_completion(mainloop, &mut operation, deadline);
    drop(operation);

    let result = sources
        .replace(Ok(Vec::new()))
        .map_err(anyhow::Error::from)
        .context("Failed to list PulseAudio sources")?;
    operation_result?;
    Ok(result)
}

fn default_name_impl(
    mainloop: &mut Mainloop,
    context: &Context,
    deadline: Instant,
    pick: impl Fn(&ServerInfo) -> Option<String> + 'static,
) -> Result<Option<String>> {
    let default_name: Rc<RefCell<Option<String>>> = Rc::new(RefCell::new(None));
    let default_name_cb = default_name.clone();

    let mut operation = context.introspect().get_server_info(move |info: &ServerInfo| {
        *default_name_cb.borrow_mut() = pick(info);
    });

    run_operation_to_completion(mainloop, &mut operation, deadline)?;
    drop(operation);

    let result = default_name.borrow().clone();
    Ok(result)
}

// ---------------------------------------------------------------------------
// Public facades — signatures intentionally identical to the previous free
// functions in `pulse_linux.rs` so no call site needs to change.
// ---------------------------------------------------------------------------

pub fn list_sinks() -> Result<Vec<PulseSink>> {
    let (tx, rx) = mpsc::channel();
    enqueue(Request::ListSinks(tx))?;

    let result = rx
        .recv_timeout(CALLER_TIMEOUT)
        .map_err(|e| match e {
            RecvTimeoutError::Timeout => anyhow!(
                "PulseAudio enumerator response timed out after {:?}",
                CALLER_TIMEOUT
            ),
            RecvTimeoutError::Disconnected => {
                anyhow!("PulseAudio enumerator thread disconnected")
            }
        })?;

    debug!("pulse_linux::list_sinks: got {} sink(s)", result.as_ref().map(|v| v.len()).unwrap_or(0));
    result
}

pub fn list_sources() -> Result<Vec<PulseSource>> {
    let (tx, rx) = mpsc::channel();
    enqueue(Request::ListSources(tx))?;

    let result = rx
        .recv_timeout(CALLER_TIMEOUT)
        .map_err(|e| match e {
            RecvTimeoutError::Timeout => anyhow!(
                "PulseAudio enumerator response timed out after {:?}",
                CALLER_TIMEOUT
            ),
            RecvTimeoutError::Disconnected => {
                anyhow!("PulseAudio enumerator thread disconnected")
            }
        })?;

    debug!(
        "pulse_linux::list_sources: got {} source(s)",
        result.as_ref().map(|v| v.len()).unwrap_or(0)
    );
    result
}

fn request_default_name(
    make: impl FnOnce(mpsc::Sender<Result<Option<String>>>) -> Request,
) -> Result<Option<String>> {
    let (tx, rx) = mpsc::channel();
    enqueue(make(tx))?;

    rx.recv_timeout(CALLER_TIMEOUT)
        .map_err(|e| match e {
            RecvTimeoutError::Timeout => anyhow!(
                "PulseAudio enumerator response timed out after {:?}",
                CALLER_TIMEOUT
            ),
            RecvTimeoutError::Disconnected => {
                anyhow!("PulseAudio enumerator thread disconnected")
            }
        })
        .and_then(|r| r)
}

pub fn default_source_name() -> Result<Option<String>> {
    request_default_name(Request::DefaultSourceName)
}

pub fn default_sink_name() -> Result<Option<String>> {
    request_default_name(Request::DefaultSinkName)
}
