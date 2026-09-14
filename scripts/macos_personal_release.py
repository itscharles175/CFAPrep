#!/usr/bin/env python3
"""Build, preserve, sign, package, and install the personal arm64 macOS release.

The pipeline is deliberately separate from the public Developer ID/notarization
workflow. It never reports an ad-hoc signature as Developer ID or notarized, and
it refuses to mutate the live profile until a byte-for-byte clone restore has
been proven.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import platform
import plistlib
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import uuid
import zipfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Sequence
from urllib import error as urlerror
from urllib import request as urlrequest


SCHEMA = "studyvault.macos-acceptance.v1"
REPO_ROOT = Path(__file__).resolve().parents[1]
OUTPUT_ROOT = REPO_ROOT / "release-personal"
EVIDENCE_ROOT = OUTPUT_ROOT / "evidence"
BUILDER_CONFIG = REPO_ROOT / "electron-builder.personal.yml"
PROFILE_ROOT = Path.home() / "Library" / "Application Support" / "StudyVault"
BACKUP_ROOT = Path.home() / "Documents" / "StudyVault Backups"
INSTALL_PATH = Path("/Applications/StudyVault.app")
SIDECAR_PORTS = (8000, 5055, 8100)
LMSTUDIO_MODELS_URL = "http://127.0.0.1:1234/v1/models"
LMSTUDIO_BASE_URL = "http://127.0.0.1:1234/v1"
class ReleaseError(RuntimeError):
    pass


@dataclass(frozen=True)
class CommandResult:
    command: list[str]
    seconds: float
    stdout: str


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def timestamp_slug() -> str:
    return datetime.now().strftime("%Y%m%d-%H%M%S")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def files_under(root: Path) -> list[Path]:
    if not root.exists():
        return []
    return sorted(path for path in root.rglob("*") if path.is_file() and not path.is_symlink())


def tree_manifest(root: Path) -> dict[str, dict[str, Any]]:
    manifest: dict[str, dict[str, Any]] = {}
    for path in files_under(root):
        relative = path.relative_to(root).as_posix()
        manifest[relative] = {"size": path.stat().st_size, "sha256": sha256_file(path)}
    return manifest


def tree_digest(manifest: dict[str, dict[str, Any]]) -> str:
    digest = hashlib.sha256()
    for name, item in sorted(manifest.items()):
        digest.update(f"{name}\0{item['sha256']}\0{item['size']}\n".encode("utf-8"))
    return digest.hexdigest()


def compare_manifests(expected: dict[str, Any], actual: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    for name in sorted(expected.keys() | actual.keys()):
        if name not in expected:
            errors.append(f"unexpected file: {name}")
        elif name not in actual:
            errors.append(f"missing file: {name}")
        elif expected[name] != actual[name]:
            errors.append(f"checksum or size mismatch: {name}")
    return errors


def run(command: Sequence[str], *, cwd: Path = REPO_ROOT, env: dict[str, str] | None = None) -> CommandResult:
    started = time.monotonic()
    merged_env = os.environ.copy()
    if env:
        merged_env.update(env)
    result = subprocess.run(
        list(command), cwd=cwd, env=merged_env, check=False, text=True,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )
    elapsed = time.monotonic() - started
    if result.returncode:
        raise ReleaseError(f"{' '.join(command)} failed ({result.returncode}):\n{result.stdout.strip()}")
    return CommandResult(list(command), elapsed, result.stdout)


def command_exists(name: str) -> bool:
    return shutil.which(name) is not None


def discover_lmstudio_release_environment(
    *, models_url: str = LMSTUDIO_MODELS_URL,
) -> tuple[dict[str, str], dict[str, Any]]:
    """Bind release checks to models LM Studio reports as loaded right now."""
    try:
        with urlrequest.urlopen(models_url, timeout=5) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (OSError, urlerror.URLError, json.JSONDecodeError) as error:
        raise ReleaseError(f"LM Studio model discovery failed at {models_url}: {type(error).__name__}") from error
    rows = payload.get("data") if isinstance(payload, dict) else None
    model_ids = [
        str(row.get("id")).strip()
        for row in rows if isinstance(row, dict) and str(row.get("id") or "").strip()
    ] if isinstance(rows, list) else []
    model_ids = list(dict.fromkeys(model_ids))
    chat_models = [model_id for model_id in model_ids if "embed" not in model_id.lower()]
    embedding_models = [model_id for model_id in model_ids if "embed" in model_id.lower()]
    if not chat_models:
        raise ReleaseError("LM Studio is reachable but /v1/models reports no loaded chat-capable model")
    primary = chat_models[0]
    critic = chat_models[1] if len(chat_models) > 1 else primary
    environment = {
        "LSATLAB_LOCAL_PROVIDER": "lmstudio",
        "LSATLAB_LMSTUDIO_URL": LMSTUDIO_BASE_URL,
        "LSATLAB_GEN_PROVIDER": "ollama",
        "LSATLAB_ENFORCE_OFFLINE": "1",
        "LSATLAB_CLOUD_EGRESS_ALLOWED": "0",
        "LSATLAB_EXPLAIN_MODEL": primary,
        "LSATLAB_EXPLAIN_FALLBACK_MODEL": primary,
        "LSATLAB_DIAGNOSE_MODEL": primary,
        "LSATLAB_GEN_MODEL": primary,
        "LSATLAB_TAG_MODEL": primary,
        "LSATLAB_GEN_CRITIC_MODEL": critic,
    }
    if embedding_models:
        environment["LSATLAB_EMBED_MODEL"] = embedding_models[0]
    evidence = {
        "name": "LM Studio release model discovery",
        "status": "pass",
        "provider": "lmstudio",
        "endpoint": models_url,
        "discovered_model_count": len(model_ids),
        "chat_model_count": len(chat_models),
        "embedding_model_count": len(embedding_models),
        "role_models": {
            "explain": primary,
            "diagnose": primary,
            "generation": primary,
            "critic": critic,
            "embedding": embedding_models[0] if embedding_models else None,
        },
        "offline_fence": True,
    }
    return environment, evidence


def validate_host() -> None:
    if sys.platform != "darwin":
        raise ReleaseError("personal macOS release must run on macOS")
    if platform.machine() != "arm64":
        raise ReleaseError(f"personal release requires arm64; found {platform.machine()}")
    for command in ("codesign", "hdiutil", "ditto", "lsof", "file", "npm", "node"):
        if not command_exists(command):
            raise ReleaseError(f"required command is unavailable: {command}")


def listening_ports(ports: Iterable[int] = SIDECAR_PORTS) -> dict[int, str]:
    occupied: dict[int, str] = {}
    for port in ports:
        probe = subprocess.run(
            ["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN"],
            check=False, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        )
        lines = [line for line in probe.stdout.splitlines() if line.strip()]
        if probe.returncode == 0 and len(lines) > 1:
            occupied[port] = "\n".join(lines)
    return occupied


def quit_studyvault() -> None:
    subprocess.run(
        ["osascript", "-e", 'tell application "StudyVault" to quit'],
        check=False, text=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        process = subprocess.run(["pgrep", "-x", "StudyVault"], check=False, stdout=subprocess.DEVNULL)
        if process.returncode != 0 and not listening_ports():
            return
        time.sleep(0.25)
    occupied = listening_ports()
    detail = "\n".join(occupied.values()) if occupied else "StudyVault is still running"
    raise ReleaseError(f"StudyVault did not quit cleanly; no process was killed:\n{detail}")


def sqlite_counts(profile: Path) -> dict[str, int]:
    counts: dict[str, int] = {}
    for db_path in sorted(profile.rglob("*.db")) if profile.exists() else []:
        try:
            uri = f"file:{db_path}?mode=ro&immutable=1"
            with sqlite3.connect(uri, uri=True) as connection:
                tables = connection.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
                ).fetchall()
                for (table,) in tables:
                    safe_table = str(table).replace('"', '""')
                    count = connection.execute(f'SELECT COUNT(*) FROM "{safe_table}"').fetchone()[0]
                    counts[f"{db_path.relative_to(profile).as_posix()}:{table}"] = int(count)
        except sqlite3.Error:
            continue
    indexed = profile / "IndexedDB"
    counts["chromium:IndexedDB-files"] = len(files_under(indexed))
    counts["chromium:Local-Storage-files"] = len(files_under(profile / "Local Storage"))
    return counts


def sqlite_value(value: Any) -> Any:
    if isinstance(value, bytes):
        return {"blob_hex": value.hex()}
    if isinstance(value, float):
        return {"float": value.hex()}
    return value


def sqlite_logical_audit(profile: Path) -> dict[str, Any]:
    audits: dict[str, Any] = {}
    candidates = {
        path for pattern in ("*.db", "*.sqlite", "*.sqlite3")
        for path in profile.rglob(pattern)
        if path.is_file()
    } if profile.exists() else set()
    for db_path in sorted(candidates):
        relative = db_path.relative_to(profile).as_posix()
        try:
            with sqlite3.connect(f"file:{db_path}?mode=ro", uri=True) as connection:
                integrity_rows = [row[0] for row in connection.execute("PRAGMA integrity_check").fetchall()]
                foreign_keys = [list(row) for row in connection.execute("PRAGMA foreign_key_check").fetchall()]
                user_version = int(connection.execute("PRAGMA user_version").fetchone()[0])
                schema_version = int(connection.execute("PRAGMA schema_version").fetchone()[0])
                tables = connection.execute(
                    "SELECT name, COALESCE(sql, '') FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
                ).fetchall()
                table_evidence = {}
                for table, schema_sql in tables:
                    quoted = str(table).replace('"', '""')
                    rows = [
                        json.dumps([sqlite_value(value) for value in row], sort_keys=True, separators=(",", ":"), ensure_ascii=False)
                        for row in connection.execute(f'SELECT * FROM "{quoted}"').fetchall()
                    ]
                    rows.sort()
                    table_evidence[str(table)] = {
                        "count": len(rows),
                        "rows_sha256": hashlib.sha256("\n".join(rows).encode("utf-8")).hexdigest(),
                        "schema_sha256": hashlib.sha256(str(schema_sql).encode("utf-8")).hexdigest(),
                    }
                if integrity_rows != ["ok"] or foreign_keys:
                    raise ReleaseError(f"SQLite validation failed for {relative}")
                audits[relative] = {
                    "status": "pass", "integrity_check": integrity_rows,
                    "foreign_key_check": foreign_keys, "user_version": user_version,
                    "schema_version": schema_version, "tables": table_evidence,
                }
        except sqlite3.DatabaseError as error:
            audits[relative] = {
                "status": "encrypted_or_unavailable",
                "reason": "Direct SQLite inspection unavailable; packaged sidecar integrity evidence is required.",
                "error_class": type(error).__name__,
            }
    return audits


def profile_size(profile: Path) -> int:
    return sum(item["size"] for item in tree_manifest(profile).values())


def create_zip(source: Path, destination: Path, *, selected: Sequence[str] | None = None) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    names = selected or tuple(path.name for path in source.iterdir())
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name in names:
            path = source / name
            if not path.exists():
                continue
            if path.is_file():
                archive.write(path, Path(source.name) / name)
            else:
                for child in files_under(path):
                    archive.write(child, Path(source.name) / child.relative_to(source))


def create_metadata_archive(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    run(["ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", str(source), str(destination)])
    destination.chmod(0o600)


def restore_zip(archive_path: Path, destination_parent: Path) -> Path:
    destination_parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive_path, "r") as archive:
        for member in archive.infolist():
            member_path = (destination_parent / member.filename).resolve()
            if destination_parent.resolve() not in member_path.parents and member_path != destination_parent.resolve():
                raise ReleaseError(f"archive member escapes restore root: {member.filename}")
        if sys.platform != "darwin":
            archive.extractall(destination_parent)
    if sys.platform == "darwin":
        run(["ditto", "-x", "-k", str(archive_path), str(destination_parent)])
    restored = destination_parent / PROFILE_ROOT.name
    if not restored.is_dir():
        raise ReleaseError("restored profile archive did not contain the StudyVault profile root")
    return restored


def backup_and_prove(profile: Path, backup_root: Path, stamp: str) -> dict[str, Any]:
    backup_dir = backup_root / f"StudyVault-{stamp}"
    backup_dir.mkdir(parents=True, exist_ok=False)
    backup_dir.chmod(0o700)
    manifest_before = tree_manifest(profile)
    counts_before = sqlite_counts(profile)
    sqlite_before = sqlite_logical_audit(profile)
    size_before = profile_size(profile)

    filesystem_archive = backup_dir / f"studyvault-profile-{stamp}.zip"
    create_metadata_archive(profile, filesystem_archive)
    legacy_surreal = INSTALL_PATH / "Contents" / "Resources" / "services" / "surreal_data"
    legacy_surreal_evidence: dict[str, Any] = {"present": False, "source": "installed-app-resources"}
    if legacy_surreal.is_dir():
        legacy_manifest = tree_manifest(legacy_surreal)
        legacy_archive = backup_dir / f"studyvault-legacy-surrealdb-{stamp}.zip"
        create_metadata_archive(legacy_surreal, legacy_archive)
        legacy_surreal_evidence = {
            "present": True, "source": "installed-app-resources", "tree_sha256": tree_digest(legacy_manifest),
            "file_count": len(legacy_manifest), "size_bytes": sum(item["size"] for item in legacy_manifest.values()),
            "archive": legacy_archive.name, "archive_sha256": sha256_file(legacy_archive),
        }

    clone_parent = backup_dir / "isolated-restore"
    clone_parent.mkdir(mode=0o700)
    clone = restore_zip(filesystem_archive, clone_parent)
    manifest_after = tree_manifest(clone)
    mismatches = compare_manifests(manifest_before, manifest_after)
    counts_after = sqlite_counts(clone)
    sqlite_after = sqlite_logical_audit(clone)
    if counts_before != counts_after:
        mismatches.append("logical store counts changed after archive restore")
    if sqlite_before != sqlite_after:
        mismatches.append("SQLite logical audit changed after archive restore")
    if mismatches:
        raise ReleaseError("profile restore parity failed: " + "; ".join(mismatches[:20]))

    manifest_path = backup_dir / "backup-manifest.json"
    manifest = {
        "schema": "studyvault.profile-backup.v1",
        "created_at": utc_now(),
        "profile_name": profile.name,
        "profile_size": size_before,
        "file_count": len(manifest_before),
        "profile_tree_sha256": tree_digest(manifest_before),
        "store_counts": counts_before,
        "sqlite_audit": sqlite_before,
        "backend_online_backup": {
            "status": "inapplicable",
            "reason": "The sidecar was quiesced. The metadata-preserving filesystem archive contains the canonical lsat-backend database, WAL, and SHM files when present.",
        },
        "semantic_vault_export": {"status": "pending_packaged_clone_export"},
        "filesystem_archive": {"name": filesystem_archive.name, "sha256": sha256_file(filesystem_archive)},
        "legacy_surrealdb": legacy_surreal_evidence,
        "restore_clone": {
            "path": "isolated-restore/StudyVault",
            "parity": "pass",
            "file_count": len(manifest_after),
            "profile_size": profile_size(clone),
            "tree_sha256": tree_digest(manifest_after),
            "store_counts": counts_after,
            "sqlite_audit": sqlite_after,
        },
    }
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    manifest_path.chmod(0o600)
    return {"directory": backup_dir, "archive": filesystem_archive, "clone": clone, "manifest": manifest_path}


def validate_source_stores(summary: dict[str, Any], *, phase: str) -> dict[str, Any]:
    required = {"sourceDocuments", "sourceChunks", "sourceIndexes", "sourceIngestionRuns", "sourceLinks", "sourceLinkOverrides"}
    exported = {key.rsplit(":", 1)[-1] for key in summary.get("counts", {})}
    version = int(summary.get("databaseVersions", {}).get("quantvault", 0))
    if phase == "pre" and version in {0, 1, 2, 3, 4, 5}:
        return {"phase": phase, "quantvault_schema_version": version, "source_store_contract": "legacy-not-yet-present"}
    if phase == "pre" and version not in {11, 12}:
        raise ReleaseError(f"unsupported pre-migration quantvault schema version: {version}")
    if phase == "post" and version != 12:
        raise ReleaseError(f"post-migration quantvault schema must be 12; found {version}")
    if phase not in {"pre", "post"}:
        raise ReleaseError(f"invalid semantic export phase: {phase}")
    missing = sorted(required - exported)
    if missing:
        raise ReleaseError("semantic export omitted source-vault stores: " + ", ".join(missing))
    return {"phase": phase, "quantvault_schema_version": version, "source_store_contract": "current-complete"}


def pre_migration_semantic_export(backup: dict[str, Any]) -> dict[str, Any]:
    output = backup["directory"] / "semantic-vault-export-before-migration.json"
    result = run([
        str(REPO_ROOT / "node_modules" / ".bin" / "electron"),
        "scripts/macos-vault-preflight-export.cjs", "--profile", str(backup["clone"]), "--output", str(output),
    ])
    summary = json.loads(result.stdout.strip().splitlines()[-1])
    schema_evidence = validate_source_stores(summary, phase="pre")
    evidence = {
        "path": output.name, "sha256": sha256_file(output), "store_counts": summary["counts"],
        "store_digests": summary["digests"], "database_versions": summary.get("databaseVersions", {}),
        "schema_evidence": schema_evidence,
    }
    manifest = json.loads(backup["manifest"].read_text(encoding="utf-8"))
    manifest["semantic_vault_export"] = {"before_migration": evidence, "after_migration": {"status": "pending"}}
    backup["manifest"].write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return evidence


def compare_semantic_migration(before: dict[str, Any], after: dict[str, Any]) -> dict[str, Any]:
    before_counts = before["store_counts"]
    after_counts = after["store_counts"]
    before_digests = before["store_digests"]
    after_digests = after["store_digests"]
    failures = []
    operational = {"studyTrail", "vaultHealthSnapshots", "releaseRunHistory", "contentVersions"}
    skipped = []
    empty_additions = []
    for store in sorted(before_counts.keys() | after_counts.keys()):
        if store.rsplit(":", 1)[-1] in operational:
            skipped.append(store)
            continue
        if store not in before_counts:
            if after_counts[store] != 0:
                failures.append(f"new store is unexpectedly non-empty: {store}")
            else:
                empty_additions.append(store)
        elif store not in after_counts:
            failures.append(f"store disappeared during migration: {store}")
        elif before_counts[store] != after_counts[store] or before_digests[store] != after_digests[store]:
            failures.append(f"store changed during migration: {store}")
    if failures:
        raise ReleaseError("semantic migration parity failed: " + "; ".join(failures[:20]))
    return {
        "status": "pass", "stores_before": len(before_counts), "stores_after": len(after_counts),
        "operational_stores_excluded": skipped, "empty_stores_added": empty_additions,
    }


def is_macho(path: Path) -> bool:
    if not path.is_file() or path.is_symlink():
        return False
    result = subprocess.run(["file", "-b", str(path)], check=False, text=True, stdout=subprocess.PIPE)
    return "Mach-O" in result.stdout


def code_directories(app_path: Path) -> list[Path]:
    candidates = [
        path for path in app_path.rglob("*")
        if path.is_dir() and not path.is_symlink() and path.suffix in {".framework", ".app", ".xpc"}
    ]
    return sorted(candidates, key=lambda path: len(path.parts), reverse=True)


def tar_copy_without_xattrs(source: Path, destination_parent: Path) -> Path:
    """Copy a bundle without Finder/resource-fork metadata using BSD tar."""
    destination_parent.mkdir(parents=True, exist_ok=True)
    archive = destination_parent / f".{source.name}.transfer.tar"
    copy_env = {"COPYFILE_DISABLE": "1"}
    run(["tar", "--no-xattrs", "-cf", str(archive), "-C", str(source.parent), source.name], env=copy_env)
    run(["tar", "--no-xattrs", "-xf", str(archive), "-C", str(destination_parent)], env=copy_env)
    archive.unlink()
    return destination_parent / source.name


def sign_adhoc_in_place(app_path: Path) -> list[str]:
    signed: list[str] = []
    entitlements = REPO_ROOT / "electron" / "entitlements.mac.plist"
    for path in sorted((p for p in app_path.rglob("*") if is_macho(p)), key=lambda p: len(p.parts), reverse=True):
        run(["codesign", "--force", "--sign", "-", "--timestamp=none", "--options", "runtime", str(path)])
        signed.append(str(path.relative_to(app_path)))
    for path in code_directories(app_path):
        if path == app_path:
            continue
        command = ["codesign", "--force", "--sign", "-", "--timestamp=none", "--options", "runtime"]
        if path.suffix == ".app":
            command.extend(["--entitlements", str(entitlements)])
        run([*command, str(path)])
        signed.append(str(path.relative_to(app_path)))
    run([
        "codesign", "--force", "--sign", "-", "--timestamp=none", "--options", "runtime",
        "--entitlements", str(entitlements), str(app_path),
    ])
    run(["codesign", "--verify", "--deep", "--strict", "--verbose=4", str(app_path)])
    details = run(["codesign", "-dvvv", str(app_path)]).stdout
    if "Signature=adhoc" not in details and "TeamIdentifier=not set" not in details:
        raise ReleaseError("final app signature was not reported as ad-hoc")
    assert_electron_entitlements(app_path)
    return signed


def sign_adhoc(app_path: Path) -> tuple[Path, list[str]]:
    # File Provider folders can immediately recreate FinderInfo after xattr -c,
    # so the authoritative signed directory must remain outside Documents.
    # ZIP/DMG and the installed /Applications copy are emitted from this stage.
    staging = Path.home() / "Library" / "Caches" / "StudyVault" / "personal-release-signing"
    if staging.exists():
        shutil.rmtree(staging)
    staged_app = tar_copy_without_xattrs(app_path, staging)
    signed = sign_adhoc_in_place(staged_app)
    return staged_app, signed


def read_entitlements(path: Path) -> dict[str, Any]:
    result = subprocess.run(
        ["codesign", "-d", "--entitlements", ":-", str(path)], check=False,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    raw = result.stdout + result.stderr
    start = raw.find(b"<?xml")
    end = raw.find(b"</plist>", start)
    if result.returncode != 0 or start < 0:
        raise ReleaseError(f"could not read signed entitlements from {path.name}")
    try:
        return plistlib.loads(raw[start : end + len(b"</plist>")] if end >= 0 else raw[start:])
    except plistlib.InvalidFileException as error:
        raise ReleaseError(f"invalid entitlement plist on {path.name}") from error


def assert_electron_entitlements(app_path: Path) -> None:
    helper_root = app_path / "Contents" / "Frameworks"
    required = [app_path]
    for role in ("Renderer", "GPU"):
        matches = sorted(helper_root.glob(f"StudyVault Helper ({role}).app"))
        if len(matches) != 1:
            raise ReleaseError(f"expected one signed StudyVault {role} helper")
        required.append(matches[0])
    for target in required:
        entitlements = read_entitlements(target)
        if entitlements.get("com.apple.security.cs.allow-jit") is not True:
            raise ReleaseError(f"signed {target.name} is missing the JIT entitlement")
        if entitlements.get("com.apple.security.cs.allow-unsigned-executable-memory") is not True:
            raise ReleaseError(f"signed {target.name} is missing the unsigned executable memory entitlement")


def gatekeeper_evidence(app_path: Path) -> dict[str, Any]:
    result = subprocess.run(
        ["spctl", "--assess", "--type", "execute", "--verbose=4", str(app_path)],
        check=False, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )
    return {
        "command": "spctl --assess --type execute --verbose=4",
        "accepted": result.returncode == 0,
        "exit_code": result.returncode,
        "output": result.stdout.strip()[:2000],
        "interpretation": "Local Gatekeeper assessment only; ad-hoc signing is not Developer ID signing or notarization.",
    }


def verify_arm64_tree(app_path: Path) -> dict[str, Any]:
    main_executable = app_path / "Contents" / "MacOS" / "StudyVault"
    sidecar = app_path / "Contents" / "Resources" / "services" / "lsat-backend" / "lsatlab-backend"
    evidence: dict[str, Any] = {}
    for label, path in (("application", main_executable), ("lsat_sidecar", sidecar)):
        if not path.is_file():
            raise ReleaseError(f"missing {label} executable: {path}")
        output = run(["file", "-b", str(path)]).stdout.strip()
        if "arm64" not in output:
            raise ReleaseError(f"{label} is not arm64: {output}")
        evidence[label] = {"path": str(path.relative_to(app_path)), "file": output, "sha256": sha256_file(path)}
    return evidence


def packaged_sidecar_provenance(app_path: Path, architecture: dict[str, Any]) -> dict[str, Any]:
    services = app_path / "Contents" / "Resources" / "services"
    manifest_path = services / "sidecar-provenance.json"
    if not manifest_path.is_file():
        raise ReleaseError("packaged sidecar provenance manifest is missing")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    entry = next((item for item in manifest.get("entries", []) if item.get("service") == "LSAT backend"), None)
    if not entry:
        raise ReleaseError("packaged provenance is missing the LSAT backend entry")
    binary = services / str(entry.get("path", ""))
    if not binary.is_file() or sha256_file(binary) != entry.get("sha256") or binary.stat().st_size != entry.get("size"):
        raise ReleaseError("packaged LSAT sidecar does not match its provenance manifest")
    return {
        "status": "verified", "manifest_schema": manifest.get("schema"),
        "manifest_sha256": sha256_file(manifest_path), "entry": entry,
        "architecture": architecture["lsat_sidecar"],
    }


def verify_fuses(app_path: Path) -> str:
    result = run(["npx", "@electron/fuses", "read", "--app", str(app_path)])
    expected = {
        "RunAsNode": "Disabled",
        "EnableCookieEncryption": "Enabled",
        "EnableNodeOptionsEnvironmentVariable": "Disabled",
        "EnableNodeCliInspectArguments": "Disabled",
        "EnableEmbeddedAsarIntegrityValidation": "Enabled",
        "OnlyLoadAppFromAsar": "Enabled",
        "GrantFileProtocolExtraPrivileges": "Disabled",
    }
    failures = [
        f"{name} must be {state}"
        for name, state in expected.items()
        if f"{name} is {state}" not in result.stdout
    ]
    if failures:
        raise ReleaseError("packaged Electron fuse policy failed: " + "; ".join(failures))
    return result.stdout


def verify_ats(app_path: Path) -> dict[str, Any]:
    plist_path = app_path / "Contents" / "Info.plist"
    with plist_path.open("rb") as handle:
        info = plistlib.load(handle)
    ats = info.get("NSAppTransportSecurity", {})
    if ats.get("NSAllowsArbitraryLoads") is not False:
        raise ReleaseError("packaged app does not explicitly disable NSAllowsArbitraryLoads")
    if "NSAllowsLocalNetworking" in ats:
        raise ReleaseError("packaged app contains the broad NSAllowsLocalNetworking entitlement")
    domains = ats.get("NSExceptionDomains", {})
    if set(domains) != {"localhost", "127.0.0.1"}:
        raise ReleaseError("packaged ATS must contain exactly the localhost and 127.0.0.1 exceptions")
    if any(
        value.get("NSExceptionAllowsInsecureHTTPLoads") is not True
        or value.get("NSIncludesSubdomains") is not False
        for value in domains.values()
    ):
        raise ReleaseError("packaged loopback ATS exceptions are malformed")
    forbidden = [
        key for key in (
            "NSAudioCaptureUsageDescription", "NSBluetoothAlwaysUsageDescription",
            "NSBluetoothPeripheralUsageDescription", "NSCameraUsageDescription",
            "NSLocationAlwaysAndWhenInUseUsageDescription", "NSLocationAlwaysUsageDescription",
            "NSLocationUsageDescription", "NSLocationWhenInUseUsageDescription",
            "NSSerialPortUsageDescription", "NSUSBRestrictedMode",
        ) if key in info
    ]
    if forbidden:
        raise ReleaseError("packaged Info.plist requests unused permissions: " + ", ".join(forbidden))
    if not info.get("NSMicrophoneUsageDescription"):
        raise ReleaseError("packaged app is missing its user-facing voice-study microphone declaration")
    return {"allows_arbitrary_loads": False, "exception_domains": sorted(domains), "microphone_declared": True}


def build_app(skip_sidecar_build: bool) -> tuple[Path, list[dict[str, Any]]]:
    if OUTPUT_ROOT.exists():
        shutil.rmtree(OUTPUT_ROOT)
    results: list[dict[str, Any]] = []
    commands = [] if skip_sidecar_build else [("arm64 LSAT sidecar build", ["npm", "run", "build:lsat-binary"])]
    commands.extend([
        ("sidecar provenance verification", ["npm", "run", "check:sidecar-provenance"]),
        ("production renderer build", ["npm", "run", "build"]),
        ("arm64 Electron application build", ["npx", "electron-builder", "--mac", "--arm64", "--dir", "--config", str(BUILDER_CONFIG)]),
    ])
    for name, command in commands:
        result = run(command)
        results.append({"name": name, "status": "pass", "seconds": round(result.seconds, 3), "command": " ".join(command)})
    apps = sorted(OUTPUT_ROOT.glob("mac*/StudyVault.app"))
    if len(apps) != 1:
        raise ReleaseError(f"expected exactly one packaged app; found {len(apps)} under {OUTPUT_ROOT}")
    return apps[0], results


def run_full_gates(app_path: Path, model_environment: dict[str, str]) -> list[dict[str, Any]]:
    # Keep the venv entry-point path itself. Resolving its symlink selects the
    # base interpreter and silently drops the environment's site-packages.
    backend_python = REPO_ROOT / "services" / "lsat-backend" / ".venv" / "bin" / "python"
    if not backend_python.is_file():
        raise ReleaseError(f"LSAT backend release Python is unavailable: {backend_python}")
    dependency_probe = run([str(backend_python), "-c", "import sqlmodel"])
    results = [{"name": "LSAT release Python dependencies", "status": "pass", "seconds": round(dependency_probe.seconds, 3)}]
    for name, command in (
        (
            "complete packaged release trust",
            [
                sys.executable, "scripts/release_local.py", "--trust-tier", "packaged",
                "--python", str(backend_python), "--personal-macos-app", str(app_path.resolve()),
            ],
        ),
        ("Electron runtime test suite", ["npm", "run", "test:electron"]),
    ):
        result = run(command, env=model_environment)
        results.append({"name": name, "status": "pass", "seconds": round(result.seconds, 3), "command": " ".join(command)})
    return results


def validate_visual_runs(run_ids: Sequence[str]) -> list[dict[str, Any]]:
    if not run_ids:
        raise ReleaseError("at least one completed authoritative Vizier run is required")
    evidence = []
    current_commit = run(["git", "rev-parse", "HEAD"]).stdout.strip()
    for run_id in run_ids:
        if not run_id.startswith("run_") or "/" in run_id or ".." in run_id:
            raise ReleaseError(f"invalid Vizier run id: {run_id}")
        report_path = REPO_ROOT / ".vizier" / "runs" / run_id / "reports" / "report.json"
        if not report_path.is_file():
            raise ReleaseError(f"Vizier report is unavailable: {report_path}")
        report = json.loads(report_path.read_text(encoding="utf-8"))
        gate = report.get("gate", {})
        coverage = gate.get("coverage", {})
        if gate.get("status") != "pass" or coverage.get("complete") is not True or coverage.get("executionState") != "complete":
            raise ReleaseError(f"Vizier run {run_id} is not an authoritative complete pass")
        if report.get("run", {}).get("gitCommit") != current_commit:
            raise ReleaseError(f"Vizier run {run_id} was captured from a different commit")
        evidence.append({
            "run_id": run_id, "gate_verdict": "pass", "score": gate.get("score"),
            "captured_surfaces": coverage.get("capturedSurfaces"), "expected_surfaces": coverage.get("expectedSurfaces"),
            "required_checks": coverage.get("requiredChecks"), "successful_required_checks": coverage.get("successfulRequiredChecks"),
        })
    return evidence


def create_distribution(app_path: Path) -> tuple[Path, Path]:
    version = json.loads((REPO_ROOT / "package.json").read_text(encoding="utf-8"))["version"]
    zip_path = OUTPUT_ROOT / f"StudyVault-{version}-mac-arm64.zip"
    dmg_path = OUTPUT_ROOT / f"StudyVault-{version}-mac-arm64.dmg"
    for path in (zip_path, dmg_path):
        path.unlink(missing_ok=True)
    run(["ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", str(app_path), str(zip_path)])
    staging = Path(tempfile.mkdtemp(prefix="studyvault-dmg-"))
    try:
        shutil.copytree(app_path, staging / app_path.name, symlinks=True)
        (staging / "Applications").symlink_to("/Applications")
        run([
            "hdiutil", "create", "-fs", "HFS+", "-format", "UDZO", "-volname", "StudyVault",
            "-srcfolder", str(staging), str(dmg_path),
        ])
    finally:
        shutil.rmtree(staging, ignore_errors=True)
    return zip_path, dmg_path


def verify_distribution(zip_path: Path, dmg_path: Path) -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="studyvault-artifact-verify-", dir="/private/tmp") as raw:
        temporary = Path(raw)
        zip_root = temporary / "zip"
        run(["ditto", "-x", "-k", str(zip_path), str(zip_root)])
        run(["codesign", "--verify", "--deep", "--strict", "--verbose=4", str(zip_root / "StudyVault.app")])

        attached = subprocess.run(
            ["hdiutil", "attach", "-readonly", "-nobrowse", "-plist", str(dmg_path)],
            check=False, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        if attached.returncode != 0:
            raise ReleaseError(f"could not mount release DMG: {attached.stderr.decode(errors='replace')}")
        try:
            attachment = plistlib.loads(attached.stdout)
            mount_points = [Path(item["mount-point"]) for item in attachment.get("system-entities", []) if item.get("mount-point")]
            if len(mount_points) != 1:
                raise ReleaseError("release DMG did not expose exactly one mounted volume")
            run(["codesign", "--verify", "--deep", "--strict", "--verbose=4", str(mount_points[0] / "StudyVault.app")])
        finally:
            if 'mount_points' in locals() and mount_points:
                run(["hdiutil", "detach", str(mount_points[0])])
    return {"name": "ZIP and DMG strict signature verification", "status": "pass"}


def write_sbom(output: Path) -> dict[str, Any]:
    package = json.loads((REPO_ROOT / "package.json").read_text(encoding="utf-8"))
    lock = json.loads((REPO_ROOT / "package-lock.json").read_text(encoding="utf-8"))
    components = []
    for path, item in sorted(lock.get("packages", {}).items()):
        if not path.startswith("node_modules/") or not item.get("version"):
            continue
        components.append({
            "type": "library", "name": item.get("name") or path.removeprefix("node_modules/"),
            "version": item["version"], "scope": "optional" if item.get("optional") else "required",
            "hashes": [{"alg": "SHA-512", "content": base64.b64decode(item["integrity"].removeprefix("sha512-")).hex()}]
            if str(item.get("integrity", "")).startswith("sha512-") else [],
        })
    sbom = {
        "bomFormat": "CycloneDX", "specVersion": "1.5", "serialNumber": f"urn:uuid:{uuid.uuid4()}",
        "version": 1, "metadata": {"timestamp": utc_now(), "component": {"type": "application", "name": "StudyVault", "version": package["version"]}},
        "components": components,
    }
    output.write_text(json.dumps(sbom, indent=2) + "\n", encoding="utf-8")
    return {"path": str(output), "components": len(components), "sha256": sha256_file(output)}


def write_build_metadata(output: Path, gatekeeper: dict[str, Any]) -> dict[str, Any]:
    package = json.loads((REPO_ROOT / "package.json").read_text(encoding="utf-8"))
    metadata = {
        "schema": "studyvault.macos-build-metadata.v1", "generated_at": utc_now(),
        "commit": run(["git", "rev-parse", "HEAD"]).stdout.strip(),
        "branch": run(["git", "branch", "--show-current"]).stdout.strip(),
        "dirty": bool(run(["git", "status", "--porcelain"]).stdout.strip()),
        "architecture": platform.machine(), "macos": platform.mac_ver()[0],
        "studyvault": package["version"], "electron": package["devDependencies"]["electron"],
        "node": run(["node", "--version"]).stdout.strip(), "npm": run(["npm", "--version"]).stdout.strip(),
        "python": platform.python_version(), "signing": "adhoc", "notarized": False,
        "gatekeeper_assessment": gatekeeper,
    }
    output.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    return artifact_entry(output, "build-metadata")


def write_sha256s(output: Path, paths: Sequence[Path], app_artifact: dict[str, Any]) -> None:
    lines = [f"{sha256_file(path)}  {path.name}" for path in paths]
    lines.append(f"{app_artifact['sha256']}  StudyVault.app.tree")
    output.write_text("\n".join(lines) + "\n", encoding="utf-8")


def install_atomically(app_path: Path, install_path: Path, backup_archive: Path) -> None:
    incoming = install_path.with_name(f".{install_path.name}.incoming")
    previous = install_path.with_name(f".{install_path.name}.previous")
    if incoming.exists():
        shutil.rmtree(incoming)
    if previous.exists():
        shutil.rmtree(previous)
    shutil.copytree(app_path, incoming, symlinks=True)
    run(["codesign", "--verify", "--deep", "--strict", str(incoming)])
    try:
        if install_path.exists():
            install_path.rename(previous)
        incoming.rename(install_path)
        run(["codesign", "--verify", "--deep", "--strict", str(install_path)])
    except Exception:
        if install_path.exists():
            shutil.rmtree(install_path)
        if previous.exists():
            previous.rename(install_path)
        raise ReleaseError(f"installation failed; prior app restored. Profile backup remains at {backup_archive}")
    else:
        if previous.exists():
            shutil.rmtree(previous)


def restore_profile_atomically(archive_path: Path, profile_path: Path, failure_logs: Path) -> None:
    """Restore the pre-upgrade profile while retaining the failed state and logs."""
    quit_studyvault()
    restore_parent = Path(tempfile.mkdtemp(prefix="studyvault-profile-restore-", dir=str(profile_path.parent)))
    failed_profile = failure_logs / "failed-profile"
    failure_logs.mkdir(parents=True, exist_ok=True)
    failure_logs.chmod(0o700)
    try:
        restored = restore_zip(archive_path, restore_parent)
        if failed_profile.exists():
            shutil.rmtree(failed_profile)
        had_failed_profile = profile_path.exists()
        if had_failed_profile:
            profile_path.rename(failed_profile)
        try:
            restored.rename(profile_path)
            expected_parent = restore_zip(archive_path, failure_logs / "parity-check")
            mismatches = compare_manifests(tree_manifest(expected_parent), tree_manifest(profile_path))
            if mismatches:
                raise ReleaseError("restored profile parity check failed: " + "; ".join(mismatches[:20]))
        except Exception:
            if profile_path.exists():
                shutil.rmtree(profile_path)
            if had_failed_profile and failed_profile.exists():
                failed_profile.rename(profile_path)
            raise
    finally:
        shutil.rmtree(restore_parent, ignore_errors=True)


def wait_for_loopback_health(url: str, deadline_seconds: float) -> float:
    started = time.monotonic()
    deadline = started + deadline_seconds
    last_error = "not attempted"
    while time.monotonic() < deadline:
        try:
            with urlrequest.urlopen(url, timeout=0.75) as response:
                if 200 <= response.status < 300:
                    return time.monotonic() - started
                last_error = f"HTTP {response.status}"
        except (urlerror.URLError, TimeoutError, OSError) as error:
            last_error = str(error)
        time.sleep(0.2)
    raise ReleaseError(f"sidecar did not become healthy within {deadline_seconds:.0f}s: {last_error}")


def native_quit(process: subprocess.Popen[bytes], timeout: float = 15) -> str:
    if process.poll() is not None:
        return "already_exited"
    result = subprocess.run(
        ["osascript", "-e", 'tell application id "com.studyvault.app" to quit'],
        check=False, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )
    if result.returncode != 0:
        raise ReleaseError(f"native StudyVault Quit failed: {result.stdout.strip()}")
    try:
        process.wait(timeout=timeout)
    except subprocess.TimeoutExpired as error:
        raise ReleaseError("StudyVault did not exit after the native Quit command; process was not force-killed") from error
    return "application_quit"


def packaged_smoke(
    app_path: Path,
    profile_path: Path,
    *,
    isolated: bool,
    private_output_root: Path,
    model_environment: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Launch the actual app; clone runs always carry an explicit user-data-dir."""
    if listening_ports():
        raise ReleaseError("packaged smoke refused because a configured sidecar port is already occupied")
    executable = app_path / "Contents" / "MacOS" / "StudyVault"
    command = [str(executable)]
    import socket
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        cdp_port = int(reservation.getsockname()[1])
    command.append(f"--remote-debugging-port={cdp_port}")
    if isolated:
        command.extend([f"--user-data-dir={profile_path}", "--use-mock-keychain"])
    launch_env = {**os.environ, **(model_environment or {})}
    if isolated:
        isolated_home = profile_path.parent / "home"
        isolated_home.mkdir(parents=True, exist_ok=True)
        launch_env["HOME"] = str(isolated_home)
    log_root = EVIDENCE_ROOT / ("clone-smoke" if isolated else "live-smoke")
    log_root.mkdir(parents=True, exist_ok=True)
    stdout_path = log_root / "process.log"
    started = time.monotonic()
    with stdout_path.open("wb") as output:
        process = subprocess.Popen(command, cwd=REPO_ROOT, env=launch_env, stdout=output, stderr=subprocess.STDOUT)
        evidence = None
        try:
            deadline = started + 5
            while time.monotonic() < deadline and process.poll() is None:
                # A live main process after the first event-loop turns is the
                # deterministic launch milestone; visual window proof is kept
                # in the separate packaged screenshot gate.
                time.sleep(0.35)
                break
            if process.poll() is not None:
                raise ReleaseError(f"packaged app exited during startup with {process.returncode}")
            process_seconds = time.monotonic() - started
            if process_seconds > 5:
                raise ReleaseError(f"packaged app startup exceeded 5 seconds ({process_seconds:.3f}s)")
            sidecar_seconds = wait_for_loopback_health("http://127.0.0.1:8100/api/health", 15)
            routing = None
            if isolated:
                sample_document = profile_path.parent / "routing-probe.pdf"
                sample_document.write_bytes(b"%PDF-1.4\n% StudyVault routing probe\n")
                second = subprocess.run(
                    [str(executable), f"--user-data-dir={profile_path}", "--use-mock-keychain", str(sample_document), "studyvault://route/review"],
                    cwd=REPO_ROOT, env=launch_env, check=False, text=True,
                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=15,
                )
                if second.returncode != 0:
                    raise ReleaseError(f"second-instance routing probe exited {second.returncode}: {second.stdout[-1000:]}")
                routing = {"exit_code": second.returncode, "file": sample_document.name, "deep_link": "studyvault://route/review"}
            fresh_profile = isolated and "isolated-fresh" in profile_path.parts
            evidence = {
                "name": "packaged fresh profile smoke" if fresh_profile else "packaged clone smoke" if isolated else "packaged live smoke",
                "status": "pass", "main_process_seconds": round(process_seconds, 3),
                "sidecar_healthy_seconds": round(sidecar_seconds, 3), "user_data_dir": str(profile_path),
                "isolated": isolated, "log": str(stdout_path), "second_instance_routing": routing,
                "keychain_mode": "isolated_mock" if isolated else "native_safe_storage",
            }
            label = "fresh" if "isolated-fresh" in profile_path.parts else "clone" if isolated else "live"
            semantic_path = private_output_root / f"semantic-vault-export-{label}.json"
            export_result = run([
                "node", "scripts/macos-vault-semantic-export.mjs", "--cdp-url", f"http://127.0.0.1:{cdp_port}",
                "--output", str(semantic_path),
            ])
            summary = json.loads(export_result.stdout.strip().splitlines()[-1])
            if routing is not None and not str(summary.get("pageUrl", "")).rstrip("/").endswith("/review"):
                raise ReleaseError(f"deep-link navigation did not reach Review: {summary.get('pageUrl')}")
            if routing is not None:
                routing["renderer_url"] = summary["pageUrl"]
            schema_evidence = validate_source_stores(summary, phase="post")
            backend_integrity = summary.get("backendIntegrity", {})
            if not backend_integrity.get("available") or backend_integrity.get("result") != "ok" or backend_integrity.get("foreign_key_check", {}).get("ok") is not True:
                raise ReleaseError(f"packaged LSAT SQLite integrity evidence failed: {backend_integrity}")
            evidence["semantic_export"] = {
                "path": semantic_path.name, "sha256": sha256_file(semantic_path),
                "store_counts": summary["counts"], "store_digests": summary["digests"],
                "database_versions": summary.get("databaseVersions", {}), "schema_evidence": schema_evidence,
            }
            evidence["sqlite_integrity"] = backend_integrity
        finally:
            if process.poll() is None:
                quit_method = native_quit(process)
            else:
                quit_method = "unexpected_process_exit"
            deadline = time.monotonic() + 10
            while listening_ports() and time.monotonic() < deadline:
                time.sleep(0.25)
            if listening_ports():
                raise ReleaseError("an owned sidecar port remained open after packaged app shutdown")
        if evidence is None:
            raise ReleaseError("packaged smoke completed without evidence")
        if quit_method != "application_quit":
            raise ReleaseError(f"packaged smoke did not exercise the native Quit path: {quit_method}")
        evidence["shutdown"] = {"status": "pass", "method": quit_method, "owned_ports_closed": True}
        return evidence


def artifact_entry(path: Path, kind: str) -> dict[str, Any]:
    if path.is_dir():
        digest = hashlib.sha256()
        total = 0
        for name, item in tree_manifest(path).items():
            digest.update(f"{name}\0{item['sha256']}\0{item['size']}\n".encode())
            total += item["size"]
        return {"kind": kind, "name": path.name, "size": total, "sha256": digest.hexdigest()}
    return {"kind": kind, "name": path.name, "size": path.stat().st_size, "sha256": sha256_file(path)}


def sanitize_evidence(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: sanitize_evidence(item) for key, item in value.items()}
    if isinstance(value, list):
        return [sanitize_evidence(item) for item in value]
    if isinstance(value, str):
        return value.replace(str(REPO_ROOT), "$REPO").replace(str(Path.home()), "~")
    return value


def acceptance_payload(
    *, artifacts: list[dict[str, Any]], provenance: dict[str, Any], backup: dict[str, Any],
    tests: list[dict[str, Any]], sbom: dict[str, Any], ats: dict[str, Any], fuses: str,
    visual_runs: list[dict[str, Any]], install_status: str, gatekeeper: dict[str, Any],
    application_identity: dict[str, Any],
) -> dict[str, Any]:
    package = json.loads((REPO_ROOT / "package.json").read_text(encoding="utf-8"))
    electron = package["devDependencies"]["electron"]
    commit = run(["git", "rev-parse", "HEAD"]).stdout.strip()
    return sanitize_evidence({
        "schema": SCHEMA,
        "verdict": "pending_manual_acceptance",
        "generated_at": utc_now(),
        "commit": commit,
        "versions": {"studyvault": package["version"], "electron": electron, "macos": platform.mac_ver()[0]},
        "architecture": "arm64",
        "release_tier": "personal",
        "application_identity": application_identity,
        "artifacts": artifacts + [{"kind": "sbom", **sbom}],
        "signing": {
            "status": "verified", "identity": "adhoc", "strict_deep_verification": "pass",
            "developer_id": False, "notarized": False, "gatekeeper_public_distribution": "not_applicable",
            "gatekeeper_assessment": gatekeeper,
            "note": "Ad-hoc signing is valid for this personal local build; it is not Developer ID signing or notarization.",
        },
        "sidecar_provenance": provenance,
        "profile_migration": {
            "backup_manifest": str(backup["manifest"]), "archive": str(backup["archive"]),
            "clone": str(backup["clone"]), "filesystem_restore_parity": "pass",
            "semantic_post_migration_export": next(
                (item.get("semantic_export") for item in tests if item.get("name") == "packaged clone smoke"), None,
            ),
            "live_install": install_status,
        },
        "test_results": tests + [
            {"name": "Electron fuses", "status": "pass", "evidence": fuses.strip().splitlines()},
            {"name": "macOS transport and permission plist", "status": "pass", "evidence": ats},
        ],
        "visual_runs": visual_runs,
        "packaged_visual": {"status": "pending", "report": "$REPO/release-personal/evidence/packaged-visual/packaged-visual-manifest.json"},
        "performance": {"status": "pending", "report": "$REPO/release-personal/evidence/packaged-performance.json"},
        "manual_checks": [
            {"name": name, "status": "pending", "evidence": None}
            for name in (
                "packaged fresh-profile study loops", "cloned-profile content availability", "live profile restart",
                "native menus and Dock menu", "file/deep-link/notification routing", "failure recovery",
                "physical sleep and wake", "multiple-display recovery", "two-minute idle CPU", "thirty-minute memory soak",
            )
        ],
    })


def validate_acceptance_payload(payload: dict[str, Any]) -> None:
    required = {
        "schema", "verdict", "generated_at", "commit", "versions", "architecture", "release_tier",
        "application_identity", "artifacts", "signing", "sidecar_provenance", "profile_migration", "test_results", "visual_runs",
        "packaged_visual", "performance", "manual_checks",
    }
    missing = sorted(required - payload.keys())
    if missing:
        raise ReleaseError("acceptance report is missing fields: " + ", ".join(missing))
    if payload["schema"] != SCHEMA or payload["architecture"] != "arm64" or payload["release_tier"] != "personal":
        raise ReleaseError("acceptance report identity is invalid")
    if any(item.get("status") == "fail" for item in payload["test_results"]):
        raise ReleaseError("acceptance report contains failed automated checks")
    if payload["verdict"] == "pass":
        pending = [item.get("name") for item in payload["manual_checks"] if item.get("status") != "pass"]
        if pending:
            raise ReleaseError("acceptance cannot pass with incomplete required checks: " + ", ".join(pending))
        if not payload["visual_runs"] or any(item.get("gate_verdict") != "pass" for item in payload["visual_runs"]):
            raise ReleaseError("acceptance cannot pass without authoritative Vizier evidence")
        if payload["profile_migration"].get("live_install") != "installed_and_smoked":
            raise ReleaseError("acceptance cannot pass before the installed live profile smoke")
        if payload["packaged_visual"].get("status") != "pass":
            raise ReleaseError("acceptance cannot pass without packaged visual evidence")
        if payload["performance"].get("status") != "pass" or payload["performance"].get("authoritative") is not True:
            raise ReleaseError("acceptance cannot pass without authoritative packaged performance evidence")


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="print the exact plan without changing files or apps")
    parser.add_argument("--skip-sidecar-build", action="store_true", help="verify and reuse the existing arm64 sidecar")
    parser.add_argument("--no-install", action="store_true", help="build signed artifacts without installing /Applications")
    parser.add_argument("--skip-packaged-smoke", action="store_true", help="build artifacts without launching the packaged app")
    parser.add_argument("--skip-gates", action="store_true", help="developer-only: skip full release and Vizier gates")
    parser.add_argument("--profile", type=Path, default=PROFILE_ROOT)
    parser.add_argument("--backup-root", type=Path, default=BACKUP_ROOT)
    parser.add_argument("--visual-run", action="append", default=[])
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    if args.dry_run:
        print(json.dumps({
            "schema": "studyvault.macos-personal-release-plan.v1",
            "architecture": "arm64", "release_tier": "personal", "profile": str(args.profile),
            "backup_root": str(args.backup_root), "output": str(OUTPUT_ROOT), "install": None if args.no_install else str(INSTALL_PATH),
            "steps": [
                "validate macOS arm64 host and tools", "quit StudyVault without killing unknown processes",
                "refuse occupied sidecar ports", "discover loaded LM Studio capabilities from loopback /v1/models",
                "wire discovered model ids into exact packaged trust with the offline fence enabled",
                "create vault export and full profile archive",
                "restore isolated clone and compare every file plus store counts", "build and verify LSAT arm64 sidecar",
                "build renderer and arm64 app", "verify Electron fuses and ATS", "ad-hoc sign nested code then app",
                "strict deep signature verification", "create ZIP and DMG", "emit hashes, SBOM, metadata, and acceptance JSON",
                "launch packaged app only against the isolated restored clone",
                "atomically install after successful gates" if not args.no_install else "leave live installation unchanged",
            ],
        }, indent=2))
        return 0

    if not args.no_install and (args.skip_gates or args.skip_packaged_smoke):
        raise ReleaseError("live installation cannot skip release gates or packaged clone smoke")

    validate_host()
    quit_studyvault()
    occupied = listening_ports()
    if occupied:
        raise ReleaseError("configured sidecar port is occupied; refusing to kill or adopt it:\n" + "\n".join(occupied.values()))
    if not args.profile.is_dir():
        raise ReleaseError(f"StudyVault profile does not exist: {args.profile}")
    stamp = timestamp_slug()
    visual_evidence = [] if args.skip_gates else validate_visual_runs(args.visual_run)
    model_environment, model_evidence = discover_lmstudio_release_environment()
    backup = backup_and_prove(args.profile, args.backup_root, stamp)
    before_migration = pre_migration_semantic_export(backup)

    app_path, tests = build_app(args.skip_sidecar_build)
    architecture = verify_arm64_tree(app_path)
    provenance = packaged_sidecar_provenance(app_path, architecture)
    provenance["model_readiness"] = model_evidence
    fuses = verify_fuses(app_path)
    ats = verify_ats(app_path)
    app_path, signed_items = sign_adhoc(app_path)
    gate_results = [] if args.skip_gates else run_full_gates(app_path, model_environment)
    tests[:0] = gate_results
    gatekeeper = gatekeeper_evidence(app_path)
    zip_path, dmg_path = create_distribution(app_path)
    tests.append(verify_distribution(zip_path, dmg_path))
    EVIDENCE_ROOT.mkdir(parents=True, exist_ok=True)
    if not args.skip_packaged_smoke:
        fresh_profile = backup["directory"] / "isolated-fresh" / "StudyVault"
        fresh_profile.mkdir(parents=True)
        tests.append(packaged_smoke(app_path, fresh_profile, isolated=True, private_output_root=backup["directory"], model_environment=model_environment))
        clone_smoke = packaged_smoke(app_path, backup["clone"], isolated=True, private_output_root=backup["directory"], model_environment=model_environment)
        tests.append(clone_smoke)
        migration_parity = compare_semantic_migration(before_migration, clone_smoke["semantic_export"])
        tests.append({"name": "semantic profile migration parity", **migration_parity})
        manifest = json.loads(backup["manifest"].read_text(encoding="utf-8"))
        manifest["semantic_vault_export"]["after_migration"] = clone_smoke["semantic_export"]
        manifest["semantic_vault_export"]["parity"] = migration_parity
        backup["manifest"].write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    sbom = write_sbom(EVIDENCE_ROOT / "studyvault-sbom.cdx.json")
    artifacts = [artifact_entry(app_path, "app"), artifact_entry(zip_path, "zip"), artifact_entry(dmg_path, "dmg")]
    artifacts[0]["nested_signed_items"] = len(signed_items)
    application_identity = {
        "commit": run(["git", "rev-parse", "HEAD"]).stdout.strip(),
        "app_tree_sha256": artifacts[0]["sha256"],
        "executable_sha256": architecture["application"]["sha256"],
    }
    artifacts.append(write_build_metadata(EVIDENCE_ROOT / "build-metadata.json", gatekeeper))

    install_status = "not_requested"
    if not args.no_install:
        install_atomically(app_path, INSTALL_PATH, backup["archive"])
        try:
            if not args.skip_packaged_smoke:
                live_smoke = packaged_smoke(INSTALL_PATH, args.profile, isolated=False, private_output_root=backup["directory"], model_environment=model_environment)
                tests.append(live_smoke)
                live_parity = compare_semantic_migration(before_migration, live_smoke["semantic_export"])
                tests.append({"name": "live profile semantic parity", **live_parity})
            install_status = "installed_and_smoked"
        except Exception:
            # A failed profile can contain personal sources and answers. Keep it
            # beside the private backup, never in distributable release evidence.
            failure_root = args.backup_root / f"StudyVault-Failed-Upgrade-{stamp}"
            restore_profile_atomically(backup["archive"], args.profile, failure_root)
            raise
    payload = acceptance_payload(
        artifacts=artifacts, provenance=provenance, backup=backup, tests=tests, sbom=sbom,
        ats=ats, fuses=fuses, visual_runs=visual_evidence, install_status=install_status, gatekeeper=gatekeeper,
        application_identity=application_identity,
    )
    validate_acceptance_payload(payload)
    acceptance_path = EVIDENCE_ROOT / "macos-acceptance.json"
    acceptance_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    write_sha256s(
        OUTPUT_ROOT / "SHA256SUMS.txt",
        [zip_path, dmg_path, EVIDENCE_ROOT / "studyvault-sbom.cdx.json", EVIDENCE_ROOT / "build-metadata.json", acceptance_path],
        artifacts[0],
    )
    print(f"StudyVault personal release candidate generated: {acceptance_path}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ReleaseError as error:
        print(f"macos-personal-release: {error}", file=sys.stderr)
        raise SystemExit(1)
