// QuantVault desktop shell — supervises the local sidecars (SurrealDB,
// open-notebook API, and its job worker) and hosts the QuantVault UI as the
// webview. Fully offline; everything runs on the user's machine.
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::{Manager, RunEvent};

#[derive(Default)]
struct Sidecars(Mutex<Vec<Child>>);

/// Locate the local services directory. Override with QV_SERVICES_DIR; otherwise
/// look for a `spike/` dir near the working directory (dev) — later this points
/// at bundled resources.
fn services_dir() -> PathBuf {
    if let Ok(p) = std::env::var("QV_SERVICES_DIR") {
        return PathBuf::from(p);
    }
    let cwd = std::env::current_dir().unwrap_or_default();
    for cand in [cwd.join("spike"), cwd.join("..").join("spike")] {
        if cand.join("bin").exists() || cand.join("open-notebook").exists() {
            return cand;
        }
    }
    cwd.join("spike")
}

fn spawn_sidecars() -> Vec<Child> {
    let dir = services_dir();
    let onb = dir.join("open-notebook");
    let env_file = onb.join(".env");
    let mut kids = Vec::new();

    // 1) SurrealDB (single binary, the one local brain)
    let db = dir.join("surreal_data").join("db");
    match Command::new(dir.join("bin").join("surreal2.exe"))
        .args(["start", "--user", "root", "--pass", "root"])
        .arg(format!("rocksdb:{}", db.display()))
        .spawn()
    {
        Ok(c) => {
            log::info!("sidecar: SurrealDB started (pid {})", c.id());
            kids.push(c);
        }
        Err(e) => log::error!("sidecar: SurrealDB failed to start: {e}"),
    }

    // 2) open-notebook FastAPI backend
    match Command::new("uv")
        .arg("run").arg("--directory").arg(&onb)
        .arg("--env-file").arg(&env_file)
        .args(["python", "run_api.py"])
        .spawn()
    {
        Ok(c) => {
            log::info!("sidecar: open-notebook API started (pid {})", c.id());
            kids.push(c);
        }
        Err(e) => log::error!("sidecar: open-notebook API failed to start: {e}"),
    }

    // 3) surreal-commands job worker (PYTHONUTF8 avoids cp1252 console crash on Windows)
    match Command::new("uv")
        .env("PYTHONUTF8", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .arg("run").arg("--directory").arg(&onb)
        .arg("--env-file").arg(&env_file)
        .args(["surreal-commands-worker", "--import-modules", "commands"])
        .spawn()
    {
        Ok(c) => {
            log::info!("sidecar: open-notebook worker started (pid {})", c.id());
            kids.push(c);
        }
        Err(e) => log::error!("sidecar: open-notebook worker failed to start: {e}"),
    }

    kids
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Sidecars::default())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            let kids = spawn_sidecars();
            if let Some(state) = app.try_state::<Sidecars>() {
                *state.0.lock().unwrap() = kids;
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building QuantVault desktop app")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(state) = app.try_state::<Sidecars>() {
                    for mut child in state.0.lock().unwrap().drain(..) {
                        let _ = child.kill();
                        log::info!("sidecar: terminated on exit");
                    }
                }
            }
        });
}
