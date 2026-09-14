from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
import zipfile
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
from unittest.mock import patch

import macos_personal_release as release
import finalize_macos_acceptance as finalizer


class PersonalReleaseTests(unittest.TestCase):
    def test_tree_manifest_and_clone_restore_match(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            profile = root / "StudyVault"
            (profile / "IndexedDB").mkdir(parents=True)
            (profile / "IndexedDB" / "000003.log").write_bytes(b"vault")
            (profile / "Preferences").write_text("{}", encoding="utf-8")
            archive = root / "profile.zip"
            release.create_zip(profile, archive)
            restored = release.restore_zip(archive, root / "clone")
            self.assertEqual(release.tree_manifest(profile), release.tree_manifest(restored))

    def test_restore_rejects_zip_slip(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            archive = root / "bad.zip"
            with zipfile.ZipFile(archive, "w") as handle:
                handle.writestr("../outside", "bad")
            with self.assertRaises(release.ReleaseError):
                release.restore_zip(archive, root / "clone")

    def test_compare_manifests_reports_all_drift_types(self) -> None:
        expected = {"a": {"size": 1, "sha256": "a"}, "b": {"size": 2, "sha256": "b"}}
        actual = {"a": {"size": 1, "sha256": "z"}, "c": {"size": 3, "sha256": "c"}}
        errors = release.compare_manifests(expected, actual)
        self.assertEqual(len(errors), 3)
        self.assertTrue(any("mismatch" in error for error in errors))
        self.assertTrue(any("missing" in error for error in errors))
        self.assertTrue(any("unexpected" in error for error in errors))

    def test_sqlite_audit_records_integrity_schema_and_row_digests(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            profile = Path(raw)
            db = profile / "lsat-backend" / "lsatlab.db"
            db.parent.mkdir()
            with sqlite3.connect(db) as connection:
                connection.execute("CREATE TABLE attempts (id INTEGER PRIMARY KEY, score INTEGER NOT NULL)")
                connection.execute("INSERT INTO attempts(score) VALUES (80), (90)")
                connection.execute("PRAGMA user_version = 30")
            audit = release.sqlite_logical_audit(profile)["lsat-backend/lsatlab.db"]
            self.assertEqual(audit["status"], "pass")
            self.assertEqual(audit["integrity_check"], ["ok"])
            self.assertEqual(audit["foreign_key_check"], [])
            self.assertEqual(audit["user_version"], 30)
            self.assertEqual(audit["tables"]["attempts"]["count"], 2)
            self.assertRegex(audit["tables"]["attempts"]["rows_sha256"], r"^[0-9a-f]{64}$")

    def test_semantic_migration_protects_content_and_allows_operational_rows(self) -> None:
        empty_digest = "e" * 64
        before = {"store_counts": {"quantvault:notes": 1, "quantvault:studyTrail": 0}, "store_digests": {"quantvault:notes": "a" * 64, "quantvault:studyTrail": empty_digest}}
        after = {
            "store_counts": {"quantvault:notes": 1, "quantvault:studyTrail": 1, "quantvault:sourceDocuments": 0},
            "store_digests": {
                "quantvault:notes": "a" * 64, "quantvault:studyTrail": "b" * 64,
                "quantvault:sourceDocuments": empty_digest,
            },
        }
        result = release.compare_semantic_migration(before, after)
        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["empty_stores_added"], ["quantvault:sourceDocuments"])
        changed = {**after, "store_digests": {**after["store_digests"], "quantvault:notes": "c" * 64}}
        with self.assertRaises(release.ReleaseError):
            release.compare_semantic_migration(before, changed)

    def test_acceptance_cannot_pass_with_pending_manual_checks(self) -> None:
        payload = {
            "schema": release.SCHEMA, "verdict": "pass", "generated_at": "2026-01-01T00:00:00Z",
            "commit": "a" * 40, "versions": {}, "architecture": "arm64", "release_tier": "personal",
            "application_identity": {"commit": "a" * 40, "app_tree_sha256": "b" * 64, "executable_sha256": "c" * 64},
            "artifacts": [], "signing": {}, "sidecar_provenance": {},
            "profile_migration": {"live_install": "installed_and_smoked"}, "test_results": [],
            "visual_runs": [{"gate_verdict": "pass"}], "manual_checks": [{"name": "sleep", "status": "pending"}],
            "packaged_visual": {"status": "pass"}, "performance": {"status": "pass", "authoritative": True},
        }
        with self.assertRaisesRegex(release.ReleaseError, "incomplete required checks"):
            release.validate_acceptance_payload(payload)
        payload["verdict"] = "pending_manual_acceptance"
        release.validate_acceptance_payload(payload)

    def test_dry_run_is_machine_readable_and_non_mutating(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            output = StringIO()
            with redirect_stdout(output):
                exit_code = release.main(["--dry-run", "--profile", str(root / "missing"), "--backup-root", str(root)])
            self.assertEqual(exit_code, 0)
            self.assertEqual(list(root.iterdir()), [])
            plan = json.loads(output.getvalue())
            self.assertTrue(any("/v1/models" in step for step in plan["steps"]))

    def test_acceptance_schema_has_required_release_contract(self) -> None:
        schema_path = Path(__file__).with_name("macos-acceptance.schema.json")
        schema = json.loads(schema_path.read_text(encoding="utf-8"))
        self.assertEqual(schema["properties"]["schema"]["const"], release.SCHEMA)
        self.assertIn("manual_checks", schema["required"])
        self.assertIn("sidecar_provenance", schema["required"])
        self.assertIn("application_identity", schema["required"])
        self.assertIn("verdict", schema["required"])

    def test_personal_builder_is_loopback_only(self) -> None:
        config = Path(__file__).parents[1] / "electron-builder.personal.yml"
        text = config.read_text(encoding="utf-8")
        self.assertIn("afterPack: scripts/prepare-personal-macos-bundle.mjs", text)
        self.assertIn("NSAllowsArbitraryLoads: false", text)
        self.assertNotIn("NSAllowsLocalNetworking", text)
        self.assertNotIn("NSCameraUsageDescription", text)
        self.assertNotIn("NSBluetooth", text)
        self.assertIn("127.0.0.1", text)

    def test_package_exposes_personal_release_commands(self) -> None:
        package = json.loads((Path(__file__).parents[1] / "package.json").read_text(encoding="utf-8"))
        self.assertEqual(package["version"], "1.0.0")
        self.assertEqual(package["scripts"]["release:macos:personal"], "python3 scripts/macos_personal_release.py")
        self.assertIn("--dry-run --no-install", package["scripts"]["release:macos:personal:check"])

    def test_full_gate_uses_absolute_lsat_backend_python(self) -> None:
        result = release.CommandResult(["probe"], 0.1, "")
        signed_app = Path("/tmp/Signed StudyVault.app")
        model_environment = {"LSATLAB_LOCAL_PROVIDER": "lmstudio"}
        with patch.object(release, "run", return_value=result) as command_runner:
            release.run_full_gates(signed_app, model_environment)
        dependency_probe = command_runner.call_args_list[0].args[0]
        command = command_runner.call_args_list[1].args[0]
        python_index = command.index("--python") + 1
        expected = release.REPO_ROOT / "services" / "lsat-backend" / ".venv" / "bin" / "python"
        self.assertEqual(dependency_probe, [str(expected), "-c", "import sqlmodel"])
        self.assertEqual(Path(command[python_index]), expected)
        self.assertTrue(Path(command[python_index]).is_absolute())
        for skip_flag in ("--skip-e2e", "--skip-electron", "--skip-sidecar-build", "--skip-packaged-smoke"):
            self.assertNotIn(skip_flag, command)
        self.assertEqual(command[command.index("--trust-tier") + 1], "packaged")
        self.assertEqual(command[command.index("--personal-macos-app") + 1], str(signed_app.resolve()))
        self.assertNotIn("release-signing.mjs", command)
        self.assertEqual(command_runner.call_args_list[1].kwargs["env"], model_environment)

    def test_lmstudio_discovery_wires_loaded_models_without_hardcoded_model(self) -> None:
        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return None

            def read(self) -> bytes:
                return json.dumps({"data": [
                    {"id": "loaded-chat"}, {"id": "loaded-critic"}, {"id": "text-embedding-loaded"},
                ]}).encode()

        with patch.object(release.urlrequest, "urlopen", return_value=Response()) as opener:
            environment, evidence = release.discover_lmstudio_release_environment()

        opener.assert_called_once_with(release.LMSTUDIO_MODELS_URL, timeout=5)
        self.assertEqual(environment["LSATLAB_LOCAL_PROVIDER"], "lmstudio")
        self.assertEqual(environment["LSATLAB_EXPLAIN_MODEL"], "loaded-chat")
        self.assertEqual(environment["LSATLAB_GEN_CRITIC_MODEL"], "loaded-critic")
        self.assertEqual(environment["LSATLAB_EMBED_MODEL"], "text-embedding-loaded")
        self.assertEqual(environment["LSATLAB_ENFORCE_OFFLINE"], "1")
        self.assertEqual(environment["LSATLAB_CLOUD_EGRESS_ALLOWED"], "0")
        self.assertEqual(evidence["discovered_model_count"], 3)

    def test_lmstudio_discovery_rejects_reachable_server_without_chat_model(self) -> None:
        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return None

            def read(self) -> bytes:
                return b'{"data":[{"id":"text-embedding-only"}]}'

        with patch.object(release.urlrequest, "urlopen", return_value=Response()):
            with self.assertRaisesRegex(release.ReleaseError, "no loaded chat-capable model"):
                release.discover_lmstudio_release_environment()

    def test_pre_migration_accepts_legacy_schema_without_source_stores(self) -> None:
        summary = {
            "databaseVersions": {"quantvault": 5},
            "counts": {"quantvault:settings": 1, "quantvault:notes": 2},
        }
        evidence = release.validate_source_stores(summary, phase="pre")
        self.assertEqual(evidence["source_store_contract"], "legacy-not-yet-present")

    def test_post_migration_requires_current_schema_and_source_stores(self) -> None:
        source_names = (
            "sourceDocuments", "sourceChunks", "sourceIndexes", "sourceIngestionRuns",
            "sourceLinks", "sourceLinkOverrides",
        )
        summary = {
            "databaseVersions": {"quantvault": 12},
            "counts": {f"quantvault:{name}": 0 for name in source_names},
        }
        evidence = release.validate_source_stores(summary, phase="post")
        self.assertEqual(evidence["source_store_contract"], "current-complete")
        summary["databaseVersions"]["quantvault"] = 5
        with self.assertRaisesRegex(release.ReleaseError, "must be 12"):
            release.validate_source_stores(summary, phase="post")

    def test_finalizer_rejects_unavailable_native_capture_and_digest_drift(self) -> None:
        capture_ids = {
            "today-wide-light", "today-minimum-dark", "assessment-focus-light", "long-reading-dark",
            "empty-state-light", "offline-recovery-dark", "reduced-motion-dark", "fullscreen-light",
        }
        manifest = {
            "kind": "studyvault-packaged-visual-evidence", "status": "pass",
            "native_capture_gate": {"status": "pass"}, "commit": "a" * 40,
            "application": {"app_tree_sha256": "b" * 64, "executable_sha256": "c" * 64}, "displays": [{}],
            "captures": [
                {"id": name, "renderer_capture": {"status": "captured"}, "native_capture": {"status": "captured"}}
                for name in capture_ids
            ],
        }
        manifest["captures"][0]["native_capture"] = {"status": "unavailable"}
        with self.assertRaisesRegex(release.ReleaseError, "native captures failed"):
            finalizer.validate_packaged_visual(manifest, "a" * 40, "b" * 64, "c" * 64)
        manifest["captures"][0]["native_capture"] = {"status": "captured"}
        with self.assertRaisesRegex(release.ReleaseError, "incomplete"):
            finalizer.validate_packaged_visual(manifest, "a" * 40, "d" * 64, "c" * 64)

    def test_finalizer_requires_commit_digest_and_real_manual_evidence(self) -> None:
        report = {
            "status": "pass", "authoritative": True,
            "shutdown": {"normal_quit": True, "owned_ports_closed": True},
            "source": {"commit": "a" * 40, "working_tree_clean": True},
            "artifact": {"bundle_tree_sha256": "b" * 64, "executable_sha256": "c" * 64},
        }
        finalizer.validate_performance(report, "a" * 40, "b" * 64, "c" * 64)
        with self.assertRaisesRegex(release.ReleaseError, "signed app"):
            finalizer.validate_performance(report, "a" * 40, "d" * 64, "c" * 64)

        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            required_manual = [{"name": "physical sleep and wake", "status": "pending", "evidence": None}]
            acceptance = {
                "schema": release.SCHEMA, "verdict": "pending_manual_acceptance",
                "generated_at": "2026-01-01T00:00:00Z", "commit": "a" * 40,
                "versions": {}, "architecture": "arm64", "release_tier": "personal",
                "application_identity": {"commit": "a" * 40, "app_tree_sha256": "b" * 64, "executable_sha256": "c" * 64},
                "artifacts": [], "signing": {}, "sidecar_provenance": {},
                "profile_migration": {"live_install": "installed_and_smoked"},
                "test_results": [{"name": name, "status": "pass"} for name in finalizer.REQUIRED_AUTOMATED_CHECKS],
                "visual_runs": [{"gate_verdict": "pass"}], "packaged_visual": {"status": "pending"},
                "performance": {"status": "pending"}, "manual_checks": required_manual,
            }
            capture_ids = {
                "today-wide-light", "today-minimum-dark", "assessment-focus-light", "long-reading-dark",
                "empty-state-light", "offline-recovery-dark", "reduced-motion-dark", "fullscreen-light",
            }
            visual = {
                "kind": "studyvault-packaged-visual-evidence", "status": "pass",
                "native_capture_gate": {"status": "pass"}, "commit": "a" * 40,
                "application": {"app_tree_sha256": "b" * 64, "executable_sha256": "c" * 64}, "displays": [{}],
                "captures": [
                    {"id": name, "renderer_capture": {"status": "captured"}, "native_capture": {"status": "captured"}}
                    for name in capture_ids
                ],
            }
            paths = [root / name for name in ("acceptance.json", "visual.json", "performance.json", "manual.json")]
            for path, payload in zip(paths, (acceptance, visual, report, {"checks": [{"name": "physical sleep and wake", "status": "pass", "checked_at": "2026-01-01T12:00:00Z", "evidence": ""}]})):
                path.write_text(json.dumps(payload), encoding="utf-8")
            with self.assertRaisesRegex(release.ReleaseError, "incomplete"):
                finalizer.finalize(*paths)

    def test_fuse_verification_requires_run_as_node_disabled(self) -> None:
        insecure = release.CommandResult(
            ["npx"], 0.1,
            "RunAsNode is Enabled\nEnableCookieEncryption is Enabled\n"
            "EnableNodeOptionsEnvironmentVariable is Disabled\nEnableNodeCliInspectArguments is Disabled\n"
            "EnableEmbeddedAsarIntegrityValidation is Enabled\nOnlyLoadAppFromAsar is Enabled\n"
            "GrantFileProtocolExtraPrivileges is Disabled\n",
        )
        with patch.object(release, "run", return_value=insecure):
            with self.assertRaises(release.ReleaseError):
                release.verify_fuses(Path("StudyVault.app"))

    def test_fuse_verification_accepts_hardened_values(self) -> None:
        secure = release.CommandResult(
            ["npx"], 0.1,
            "RunAsNode is Disabled\nEnableCookieEncryption is Enabled\n"
            "EnableNodeOptionsEnvironmentVariable is Disabled\nEnableNodeCliInspectArguments is Disabled\n"
            "EnableEmbeddedAsarIntegrityValidation is Enabled\nOnlyLoadAppFromAsar is Enabled\n"
            "GrantFileProtocolExtraPrivileges is Disabled\n",
        )
        with patch.object(release, "run", return_value=secure):
            self.assertIn("RunAsNode is Disabled", release.verify_fuses(Path("StudyVault.app")))

    def test_packaged_clone_smoke_always_sets_user_data_dir(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            app = root / "StudyVault.app"
            executable = app / "Contents" / "MacOS" / "StudyVault"
            executable.parent.mkdir(parents=True)
            executable.write_text("", encoding="utf-8")
            clone = root / "clone"
            clone.mkdir()
            process = unittest.mock.MagicMock()
            process.poll.return_value = None
            process.wait.return_value = 0
            summary = {
                "counts": {f"quantvault:{name}": 0 for name in (
                    "sourceDocuments", "sourceChunks", "sourceIndexes", "sourceIngestionRuns", "sourceLinks", "sourceLinkOverrides",
                )},
                "digests": {f"quantvault:{name}": "0" * 64 for name in (
                    "sourceDocuments", "sourceChunks", "sourceIndexes", "sourceIngestionRuns", "sourceLinks", "sourceLinkOverrides",
                )},
                "backendIntegrity": {"available": True, "result": "ok", "foreign_key_check": {"ok": True}},
                "databaseVersions": {"quantvault": 12},
                "pageUrl": "app://studyvault/review",
            }
            def fake_run(command, **_kwargs):
                output = Path(command[command.index("--output") + 1])
                output.write_text("{}", encoding="utf-8")
                return release.CommandResult(list(command), 0.1, json.dumps(summary))
            with (
                patch.object(release, "listening_ports", return_value={}),
                patch.object(release, "wait_for_loopback_health", return_value=0.5),
                patch.object(release, "run", side_effect=fake_run),
                patch.object(release, "native_quit", return_value="application_quit"),
                patch.object(release, "EVIDENCE_ROOT", root / "evidence"),
                patch.object(release.subprocess, "run", return_value=release.subprocess.CompletedProcess([], 0, "")),
                patch.object(release.subprocess, "Popen", return_value=process) as popen,
            ):
                result = release.packaged_smoke(
                    app, clone, isolated=True, private_output_root=root,
                    model_environment={"LSATLAB_LOCAL_PROVIDER": "lmstudio"},
                )
            command = popen.call_args.args[0]
            launch_environment = popen.call_args.kwargs["env"]
            self.assertIn(f"--user-data-dir={clone}", command)
            self.assertIn("--use-mock-keychain", command)
            self.assertEqual(launch_environment["LSATLAB_LOCAL_PROVIDER"], "lmstudio")
            self.assertEqual(launch_environment["HOME"], str(root / "home"))
            self.assertTrue(result["isolated"])
            self.assertEqual(result["keychain_mode"], "isolated_mock")
            self.assertEqual(result["shutdown"]["method"], "application_quit")


if __name__ == "__main__":
    unittest.main()
