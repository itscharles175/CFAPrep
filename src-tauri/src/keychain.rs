//! GAP-SEC-1 — OS-keychain custody for the opt-in secure-vault key.
//!
//! The host's secure vault (`src/lib/secureVault.ts`) generates a 256-bit
//! data-encryption-key and hands it here to be CUSTODIED by the OS keychain, so
//! the key is OS-protected and never written to app storage in plaintext. On
//! Windows this is the Windows Credential Manager (a GENERIC credential, persisted
//! to the local machine, whose blob is DPAPI-protected by the OS). On other
//! platforms the commands degrade to an explicit "unsupported here" error so the
//! host's `enable()` fails cleanly (the vault simply can't be turned on) rather
//! than silently storing the key insecurely.
//!
//! runtime-verify-gated: the credential round-trip can only be exercised in a
//! packaged desktop run (it touches the real OS credential store), so this is
//! compile-gated here and verified on a Windows desktop. The Windows FFI mirrors
//! the style of `process_group.rs` (the Job Object work).
//!
//! Target naming: a single generic credential keyed by `"{service}/{account}"`
//! (e.g. `studyvault/vault-dek`). The secret blob is the UTF-8 bytes of the
//! base64 DEK.

use base64::{engine::general_purpose::STANDARD, Engine as _};

const APP_KEYCHAIN_SERVICE: &str = "studyvault";
const APP_KEYCHAIN_ACCOUNT: &str = "vault-dek";
const LSAT_DB_DEK_ACCOUNT: &str = "lsat-db-dek";
const LSAT_DB_DEK_BYTES: usize = 32;

/// Tauri command: store (or overwrite) a secret in the OS keychain.
#[tauri::command]
pub fn keychain_set(service: String, account: String, secret: String) -> Result<(), String> {
    validate_app_keychain_target(&service, &account)?;
    platform::set(&service, &account, &secret)
}

/// Tauri command: read a secret from the OS keychain. `Ok(None)` when no secret
/// is stored for `{service}/{account}` (distinct from an error).
#[tauri::command]
pub fn keychain_get(service: String, account: String) -> Result<Option<String>, String> {
    validate_app_keychain_target(&service, &account)?;
    platform::get(&service, &account)
}

/// Tauri command: delete a secret from the OS keychain. Deleting an absent
/// secret is a no-op success.
#[tauri::command]
pub fn keychain_delete(service: String, account: String) -> Result<(), String> {
    validate_app_keychain_target(&service, &account)?;
    platform::delete(&service, &account)
}

/// Internal desktop-supervisor helper: fetch or create the LSAT SQLite
/// field-encryption key. This target is intentionally NOT exposed through the
/// webview-facing keychain commands above.
pub fn get_or_create_lsat_db_dek_b64() -> Result<String, String> {
    if let Some(existing) = platform::get(APP_KEYCHAIN_SERVICE, LSAT_DB_DEK_ACCOUNT)? {
        validate_lsat_db_dek_b64(&existing)?;
        return Ok(existing);
    }
    let generated = generate_lsat_db_dek_b64()?;
    platform::set(APP_KEYCHAIN_SERVICE, LSAT_DB_DEK_ACCOUNT, &generated)?;
    Ok(generated)
}

pub fn generate_lsat_db_dek_b64() -> Result<String, String> {
    let mut bytes = [0u8; LSAT_DB_DEK_BYTES];
    getrandom::getrandom(&mut bytes)
        .map_err(|e| format!("failed to generate LSAT DB encryption key: {e}"))?;
    Ok(STANDARD.encode(bytes))
}

pub fn validate_lsat_db_dek_b64(secret: &str) -> Result<(), String> {
    let decoded = STANDARD
        .decode(secret.as_bytes())
        .map_err(|e| format!("LSAT DB encryption key is not valid base64: {e}"))?;
    if decoded.len() != LSAT_DB_DEK_BYTES {
        return Err(format!(
            "LSAT DB encryption key must decode to {LSAT_DB_DEK_BYTES} bytes"
        ));
    }
    Ok(())
}

/// The credential target name for a `{service}/{account}` pair.
fn target_name(service: &str, account: &str) -> String {
    format!("{service}/{account}")
}

fn validate_app_keychain_target(service: &str, account: &str) -> Result<(), String> {
    if service == APP_KEYCHAIN_SERVICE && account == APP_KEYCHAIN_ACCOUNT {
        Ok(())
    } else {
        Err("keychain access is restricted to StudyVault's secure-vault key".into())
    }
}

#[cfg(windows)]
mod platform {
    use super::target_name;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::ERROR_NOT_FOUND;
    use windows::Win32::Security::Credentials::{
        CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_FLAGS,
        CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
    };

    /// Build a NUL-terminated UTF-16 buffer for a Win32 wide-string argument.
    /// The returned Vec must outlive any pointer taken into it.
    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub fn set(service: &str, account: &str, secret: &str) -> Result<(), String> {
        let mut target = wide(&target_name(service, account));
        // The secret blob is the UTF-8 bytes of the base64 key. Kept alive in
        // `blob` for the duration of the CredWriteW call.
        let mut blob = secret.as_bytes().to_vec();

        let credential = CREDENTIALW {
            Flags: CRED_FLAGS(0),
            Type: CRED_TYPE_GENERIC,
            TargetName: windows::core::PWSTR(target.as_mut_ptr()),
            CredentialBlobSize: blob.len() as u32,
            CredentialBlob: blob.as_mut_ptr(),
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            ..Default::default()
        };

        // SAFETY: `credential` borrows `target` + `blob`, both alive across the
        // call (they drop at end of scope, after this returns); the struct is
        // otherwise zero-initialized via Default. CredWriteW copies the blob into
        // the credential store.
        unsafe { CredWriteW(&credential, 0) }.map_err(|e| format!("CredWriteW failed: {e}"))?;
        Ok(())
    }

    pub fn get(service: &str, account: &str) -> Result<Option<String>, String> {
        let target = wide(&target_name(service, account));
        let mut credential: *mut CREDENTIALW = std::ptr::null_mut();

        // SAFETY: `target` is a valid NUL-terminated wide string alive across the
        // call; on success `credential` points to a store-allocated CREDENTIALW we
        // must free with CredFree.
        let result = unsafe {
            CredReadW(
                PCWSTR(target.as_ptr()),
                CRED_TYPE_GENERIC,
                None,
                &mut credential,
            )
        };

        if let Err(e) = result {
            // A missing credential is not an error to the caller.
            if e.code() == windows::core::HRESULT::from_win32(ERROR_NOT_FOUND.0) {
                return Ok(None);
            }
            return Err(format!("CredReadW failed: {e}"));
        }
        if credential.is_null() {
            return Ok(None);
        }

        // SAFETY: CredReadW succeeded, so `credential` is a valid pointer to a
        // CREDENTIALW with a `CredentialBlobSize`-byte blob; we copy the bytes out
        // before freeing the store allocation.
        let secret = unsafe {
            let cred = &*credential;
            let bytes = if cred.CredentialBlob.is_null() || cred.CredentialBlobSize == 0 {
                Vec::new()
            } else {
                std::slice::from_raw_parts(cred.CredentialBlob, cred.CredentialBlobSize as usize)
                    .to_vec()
            };
            CredFree(credential as *const core::ffi::c_void);
            bytes
        };

        String::from_utf8(secret)
            .map(Some)
            .map_err(|e| format!("stored secret was not valid UTF-8: {e}"))
    }

    pub fn delete(service: &str, account: &str) -> Result<(), String> {
        let target = wide(&target_name(service, account));
        // SAFETY: `target` is a valid NUL-terminated wide string alive across the call.
        let result = unsafe { CredDeleteW(PCWSTR(target.as_ptr()), CRED_TYPE_GENERIC, None) };
        match result {
            Ok(()) => Ok(()),
            Err(e) if e.code() == windows::core::HRESULT::from_win32(ERROR_NOT_FOUND.0) => Ok(()),
            Err(e) => Err(format!("CredDeleteW failed: {e}")),
        }
    }
}

#[cfg(not(windows))]
mod platform {
    /// Non-Windows builds have no Credential Manager binding here. The secure
    /// vault is a Windows-desktop feature today, so `set` reports it's unsupported
    /// (host `enable()` fails cleanly), `get` reports no key, and `delete` is a
    /// no-op. This keeps the commands compiling on every platform.
    pub fn set(_service: &str, _account: &str, _secret: &str) -> Result<(), String> {
        Err("The OS keychain is only available in the Windows desktop build.".into())
    }
    pub fn get(_service: &str, _account: &str) -> Result<Option<String>, String> {
        Ok(None)
    }
    pub fn delete(_service: &str, _account: &str) -> Result<(), String> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{
        generate_lsat_db_dek_b64, target_name, validate_app_keychain_target,
        validate_lsat_db_dek_b64,
    };
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    #[test]
    fn target_name_joins_service_and_account() {
        assert_eq!(
            target_name("studyvault", "vault-dek"),
            "studyvault/vault-dek"
        );
    }

    #[test]
    fn keychain_target_validation_allows_only_secure_vault_key() {
        assert!(validate_app_keychain_target("studyvault", "vault-dek").is_ok());
        assert!(
            validate_app_keychain_target("studyvault", "lsat-db-dek").is_err(),
            "the LSAT DB key is internal to the sidecar supervisor, not exposed to webview commands"
        );
        assert!(validate_app_keychain_target("studyvault", "other").is_err());
        assert!(validate_app_keychain_target("other", "vault-dek").is_err());
    }

    #[test]
    fn generate_lsat_db_dek_b64_returns_32_bytes_as_base64() {
        let key = generate_lsat_db_dek_b64().expect("generated key");
        let decoded = STANDARD.decode(key.as_bytes()).expect("base64");
        assert_eq!(decoded.len(), 32);
        assert!(validate_lsat_db_dek_b64(&key).is_ok());
    }

    #[test]
    fn validate_lsat_db_dek_b64_rejects_wrong_length() {
        let short = STANDARD.encode([7u8; 31]);
        assert!(validate_lsat_db_dek_b64(&short).is_err());
        assert!(validate_lsat_db_dek_b64("not base64").is_err());
    }
}
