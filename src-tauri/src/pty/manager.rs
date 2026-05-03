use super::traits::*;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::collections::HashMap;
use std::io::Read as IoRead;
use std::io::Write as IoWrite;
use std::sync::{mpsc, Arc, Mutex};
use std::thread;

struct PtyHandle {
    writer: Box<dyn IoWrite + Send>,
    pair: portable_pty::PtyPair,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

pub struct PtyManager {
    handles: Arc<Mutex<HashMap<PaneId, PtyHandle>>>,
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            handles: Arc::new(Mutex::new(HashMap::new())),
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

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| PtyError::SpawnFailed(e.to_string()))?;

        let writer = pair
            .master
            .take_writer()
            .map_err(|e| PtyError::SpawnFailed(e.to_string()))?;

        let handle = PtyHandle {
            writer,
            pair,
            child,
        };

        let mut handles = self.handles.lock().unwrap();
        if handles.contains_key(pane_id) {
            return Err(PtyError::PaneAlreadyExists(pane_id.clone()));
        }
        handles.insert(pane_id.clone(), handle);
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
            .pair
            .master
            .try_clone_reader()
            .map_err(|e| PtyError::SpawnFailed(e.to_string()))?;

        let (tx, rx) = mpsc::channel();

        thread::spawn(move || {
            let mut buf = [0u8; 4096];
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
            .pair
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| PtyError::Io(std::io::Error::new(std::io::ErrorKind::Other, e)))?;
        Ok(())
    }
}

impl PtyLifecycle for PtyManager {
    fn kill(&self, pane_id: &PaneId) -> Result<(), PtyError> {
        let mut handles = self.handles.lock().unwrap();
        let mut handle = handles
            .remove(pane_id)
            .ok_or_else(|| PtyError::PaneNotFound(pane_id.clone()))?;
        handle.child.kill().ok();
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
