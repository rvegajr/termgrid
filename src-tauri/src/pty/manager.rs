use super::traits::*;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::collections::HashMap;
use std::io::Read as IoRead;
use std::io::Write as IoWrite;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;

struct PtyHandle {
    writer: Box<dyn IoWrite + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    killer: Box<dyn portable_pty::ChildKiller + Send + Sync>,
    pid: Option<u32>,
    suppress_exit: Arc<AtomicBool>,
}

type ExitHandler = Box<dyn Fn(PaneId) + Send + Sync>;

pub struct PtyManager {
    handles: Arc<Mutex<HashMap<PaneId, PtyHandle>>>,
    exit_handler: Arc<Mutex<Option<ExitHandler>>>,
}

impl Default for PtyManager {
    fn default() -> Self {
        Self::new()
    }
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            handles: Arc::new(Mutex::new(HashMap::new())),
            exit_handler: Arc::new(Mutex::new(None)),
        }
    }
}

impl PtySpawner for PtyManager {
    fn spawn(
        &self,
        pane_id: &PaneId,
        shell: &str,
        cwd: &str,
        cols: u16,
        rows: u16,
    ) -> Result<(), PtyError> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| PtyError::SpawnFailed(e.to_string()))?;

        let mut cmd = CommandBuilder::new(shell);
        cmd.cwd(cwd);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("CLICOLOR", "1");
        cmd.env("CLICOLOR_FORCE", "1");
        cmd.env("LSCOLORS", "ExGxBxDxCxEgEdxbxgxcxd");
        cmd.env("TERM_PROGRAM", "TermGrid");

        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| PtyError::SpawnFailed(e.to_string()))?;

        // Capture pid and killer before moving child to reaper thread
        let pid = child.process_id();
        let killer = child.clone_killer();

        let writer = pair
            .master
            .take_writer()
            .map_err(|e| PtyError::SpawnFailed(e.to_string()))?;

        // Drop slave FD immediately so master reader can see EOF when child exits
        let master = pair.master;
        drop(pair.slave);

        let suppress_exit = Arc::new(AtomicBool::new(false));
        let handle = PtyHandle {
            writer,
            master,
            killer,
            pid,
            suppress_exit: suppress_exit.clone(),
        };

        let mut handles = self.handles.lock().unwrap();
        if handles.contains_key(pane_id) {
            return Err(PtyError::PaneAlreadyExists(pane_id.clone()));
        }
        handles.insert(pane_id.clone(), handle);
        drop(handles);

        // Spawn reaper thread that owns the child and waits for it to exit
        let pane_id_clone = pane_id.clone();
        let handles_arc = self.handles.clone();
        let exit_handler_arc = self.exit_handler.clone();

        thread::spawn(move || {
            // Wait for child to exit (blocks until natural exit or kill signal)
            let _ = child.wait();

            // Remove handle from map (drops master/writer -> FDs freed)
            let mut handles = handles_arc.lock().unwrap();
            if let Some(removed_handle) = handles.remove(&pane_id_clone) {
                let should_fire_handler = !removed_handle.suppress_exit.load(Ordering::SeqCst);
                drop(handles);

                // Fire exit handler unless this was an explicit kill
                if should_fire_handler {
                    let exit_handler = exit_handler_arc.lock().unwrap();
                    if let Some(ref handler) = *exit_handler {
                        handler(pane_id_clone);
                    }
                }
            }
        });

        Ok(())
    }
}

impl PtyWriter for PtyManager {
    fn write(&self, pane_id: &PaneId, data: &[u8]) -> Result<(), PtyError> {
        let mut handles = self.handles.lock().unwrap();
        let handle = handles
            .get_mut(pane_id)
            .ok_or_else(|| PtyError::PaneNotFound(pane_id.clone()))?;
        handle.writer.write_all(data)?;
        Ok(())
    }
}

impl PtyReader for PtyManager {
    fn subscribe(&self, pane_id: &PaneId) -> Result<mpsc::Receiver<Vec<u8>>, PtyError> {
        let handles = self.handles.lock().unwrap();
        let handle = handles
            .get(pane_id)
            .ok_or_else(|| PtyError::PaneNotFound(pane_id.clone()))?;

        let mut reader = handle
            .master
            .try_clone_reader()
            .map_err(|e| PtyError::SpawnFailed(e.to_string()))?;

        let (tx, rx) = mpsc::channel();

        thread::spawn(move || {
            let mut buf = [0u8; 65536]; // 64KB buffer for high-throughput output
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if tx.send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        Ok(rx)
    }
}

impl PtyResizer for PtyManager {
    fn resize(&self, pane_id: &PaneId, cols: u16, rows: u16) -> Result<(), PtyError> {
        let handles = self.handles.lock().unwrap();
        let handle = handles
            .get(pane_id)
            .ok_or_else(|| PtyError::PaneNotFound(pane_id.clone()))?;
        handle
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| PtyError::Io(std::io::Error::other(e)))?;
        Ok(())
    }
}

impl PtyIntrospect for PtyManager {
    fn process_id(&self, pane_id: &PaneId) -> Option<u32> {
        let handles = self.handles.lock().ok()?;
        let handle = handles.get(pane_id)?;
        handle.pid
    }
}

impl PtyLifecycle for PtyManager {
    fn kill(&self, pane_id: &PaneId) -> Result<(), PtyError> {
        let mut handles = self.handles.lock().unwrap();
        let mut handle = handles
            .remove(pane_id)
            .ok_or_else(|| PtyError::PaneNotFound(pane_id.clone()))?;

        // Set suppress flag before killing so reaper doesn't fire exit handler
        handle.suppress_exit.store(true, Ordering::SeqCst);
        handle.killer.kill().ok();
        Ok(())
    }

    fn is_alive(&self, pane_id: &PaneId) -> bool {
        let handles = self.handles.lock().unwrap();
        handles.contains_key(pane_id)
    }

    fn list_active(&self) -> Vec<PaneId> {
        let handles = self.handles.lock().unwrap();
        handles.keys().cloned().collect()
    }
}

impl PtyExitObserver for PtyManager {
    fn set_exit_handler(&self, handler: Box<dyn Fn(PaneId) + Send + Sync>) {
        let mut exit_handler = self.exit_handler.lock().unwrap();
        *exit_handler = Some(handler);
    }
}
