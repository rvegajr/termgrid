//! Smoke binary: dump live adoption discovery + snapshot output.
//!
//! Run with `cargo run --example adoption_smoke` from `src-tauri/`.
//! Useful for sanity-checking the picker before launching the full app.
//! Pass a PID as the first arg to also dump that pid's v2 snapshot.
use termgrid_lib::adoption;

fn main() {
    let sessions = adoption::list_adoptable_sessions();
    println!("found {} adoptable session(s):", sessions.len());
    for s in &sessions {
        println!(
            "  pid={:<6} shell={:<10} via_ssh={} cwd={:?} tty={:?} parent={:?} last={:?}",
            s.pid, s.shell, s.via_ssh, s.cwd, s.tty, s.parent, s.last_command
        );
    }

    // Optional second pass: full snapshot for an explicit PID, exercising
    // every v2 probe (buffer scrape, env, ssh parse).
    let pid_arg: Option<u32> = std::env::args().nth(1).and_then(|s| s.parse().ok());
    if let Some(pid) = pid_arg {
        println!("\n--- snapshot for pid {} ---", pid);
        let snap = adoption::snapshot_session(pid);
        println!("shell:   {}", snap.shell);
        println!("cwd:     {:?}", snap.cwd);
        println!("tty:     {:?}", snap.tty);
        println!("banner:  {}", snap.banner);
        println!("env:     {} var(s)", snap.env_vars.len());
        for ev in &snap.env_vars {
            println!("  - {}={}", ev.name, ev.value);
        }
        match &snap.ssh_target {
            Some(t) => println!(
                "ssh:     dest={} port={:?} command={:?}",
                t.destination, t.port, t.command
            ),
            None => println!("ssh:     none"),
        }
        match &snap.buffer_preview {
            Some(b) => println!("buffer:  {} bytes\n{}", b.len(), b),
            None => println!("buffer:  none"),
        }
    } else {
        println!("\n(tip: pass a pid to see the full v2 snapshot)");
    }
}
