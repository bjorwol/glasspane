// Local secret storage for the Anthropic API key, backed by Stronghold.
//
// We use tauri-plugin-stronghold's library types directly (`stronghold::Stronghold`,
// `kdf::KeyDerivation`) rather than registering it as a Tauri plugin. The plugin's
// own command surface is designed to be driven from JS (save_secret, get_store_record,
// etc.), which would mean the frontend handles the raw key on every read. Since the
// requirement is that the key never enters the frontend at all, only this module ever
// touches the plaintext value — the frontend only ever calls save/clear/has, and the
// Anthropic HTTP call happens entirely in `organize_notes` below.
use std::sync::{Mutex, MutexGuard};

use iota_stronghold::Client;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_stronghold::{kdf::KeyDerivation, stronghold::Stronghold};

const CLIENT_PATH: &[u8] = b"glasspane";
const ANTHROPIC_KEY_RECORD: &[u8] = b"anthropic_api_key";
const ANTHROPIC_MODEL: &str = "claude-haiku-4-5-20251001";

// This app has no user-facing master password. Combined with a random,
// per-install salt file (see KeyDerivation::argon2), this is the pattern
// tauri-plugin-stronghold itself documents for local secret storage that
// doesn't prompt the user for a vault password.
const VAULT_PASSWORD: &str = "glasspane-local-vault-v1";

#[derive(Default)]
pub struct VaultState(Mutex<Option<(Stronghold, Client)>>);

fn open(app: &AppHandle) -> Result<(Stronghold, Client), String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let hash = KeyDerivation::argon2(VAULT_PASSWORD, &dir.join("vault.salt"));
    let stronghold =
        Stronghold::new(dir.join("vault.stronghold"), hash).map_err(|e| e.to_string())?;

    let client = match stronghold.load_client(CLIENT_PATH) {
        Ok(client) => client,
        Err(_) => stronghold
            .create_client(CLIENT_PATH)
            .map_err(|e| e.to_string())?,
    };

    Ok((stronghold, client))
}

fn ensure_open<'a>(
    app: &AppHandle,
    state: &'a VaultState,
) -> Result<MutexGuard<'a, Option<(Stronghold, Client)>>, String> {
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "vault lock poisoned".to_string())?;
    if guard.is_none() {
        *guard = Some(open(app)?);
    }
    Ok(guard)
}

fn read_key(app: &AppHandle, state: &VaultState) -> Result<Option<String>, String> {
    let guard = ensure_open(app, state)?;
    let (_, client) = guard.as_ref().unwrap();
    let bytes = client
        .store()
        .get(ANTHROPIC_KEY_RECORD)
        .map_err(|e| e.to_string())?;
    Ok(bytes
        .and_then(|b| String::from_utf8(b).ok())
        .filter(|s| !s.is_empty()))
}

#[tauri::command]
pub fn save_anthropic_key(app: AppHandle, state: State<VaultState>, key: String) -> Result<(), String> {
    let key = key.trim().to_string();
    if key.is_empty() {
        return Err("Key cannot be empty".into());
    }
    let guard = ensure_open(&app, &state)?;
    let (stronghold, client) = guard.as_ref().unwrap();
    client
        .store()
        .insert(ANTHROPIC_KEY_RECORD.to_vec(), key.into_bytes(), None)
        .map_err(|e| e.to_string())?;
    stronghold.save().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn clear_anthropic_key(app: AppHandle, state: State<VaultState>) -> Result<(), String> {
    let guard = ensure_open(&app, &state)?;
    let (stronghold, client) = guard.as_ref().unwrap();
    client
        .store()
        .delete(ANTHROPIC_KEY_RECORD)
        .map_err(|e| e.to_string())?;
    stronghold.save().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn has_anthropic_key(app: AppHandle, state: State<VaultState>) -> Result<bool, String> {
    Ok(read_key(&app, &state)?.is_some())
}

#[tauri::command]
pub async fn organize_notes(
    app: AppHandle,
    state: State<'_, VaultState>,
    prompt: String,
) -> Result<String, String> {
    let key = read_key(&app, &state)?
        .ok_or_else(|| "Add your Anthropic API key in settings".to_string())?;

    let client = reqwest::Client::new();
    let res = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&serde_json::json!({
            "model": ANTHROPIC_MODEL,
            "max_tokens": 1000,
            "messages": [{ "role": "user", "content": prompt }],
        }))
        .send()
        .await
        .map_err(|e| format!("Could not reach Anthropic: {e}"))?;

    let status = res.status();
    let body = res.text().await.map_err(|e| e.to_string())?;

    if !status.is_success() {
        // Anthropic's errors are informative but only in the body.
        eprintln!("Anthropic API error ({status}): {body}");
        let message = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| v.get("error")?.get("message")?.as_str().map(str::to_string));
        return Err(match status.as_u16() {
            401 => "That API key was rejected".to_string(),
            429 => "Rate limited, try again in a moment".to_string(),
            _ => message.unwrap_or_else(|| format!("Anthropic API returned {status}")),
        });
    }

    let parsed: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    parsed["content"]
        .as_array()
        .map(|blocks| {
            blocks
                .iter()
                .filter_map(|b| b["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .ok_or_else(|| "Unexpected response from Anthropic".to_string())
}
