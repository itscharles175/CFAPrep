from __future__ import annotations

import tempfile
import unittest
import subprocess
from pathlib import Path
from unittest.mock import Mock

from macos_packaged_performance import (
    HarnessError,
    Limits,
    ProcessSample,
    bundle_tree_digest,
    descendant_pids,
    endpoint_is_loopback,
    ensure_production_durations,
    isolated_environment,
    native_application_quit,
    parse_ps_rows,
    resolve_app_executable,
    resolve_app_bundle,
    sha256_file,
    summarize_samples,
    verify_arm64_macho,
)


class PackagedPerformancePolicyTests(unittest.TestCase):
    def test_production_durations_fail_closed(self) -> None:
        with self.assertRaisesRegex(HarnessError, "cannot be shortened"):
            ensure_production_durations(Limits(rss_soak_seconds=30), test_mode=False)
        ensure_production_durations(Limits(rss_soak_seconds=0.1, idle_cpu_seconds=0.1), test_mode=True)

    def test_resolves_only_exact_packaged_executable(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            app = Path(directory) / "StudyVault.app"
            executable = app / "Contents" / "MacOS" / "StudyVault"
            executable.parent.mkdir(parents=True)
            executable.write_text("fixture", encoding="utf-8")
            executable.chmod(0o755)
            self.assertEqual(resolve_app_executable(app), executable.resolve())
            self.assertEqual(resolve_app_bundle(app, executable), app.resolve())

    def test_bundle_digest_binds_file_names_hashes_and_sizes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            app = Path(directory) / "StudyVault.app"
            first = app / "Contents" / "MacOS" / "StudyVault"
            second = app / "Contents" / "Resources" / "app.asar"
            first.parent.mkdir(parents=True)
            second.parent.mkdir(parents=True)
            first.write_bytes(b"macho")
            second.write_bytes(b"asar")
            digest, count, size = bundle_tree_digest(app)
            self.assertEqual(count, 2)
            self.assertEqual(size, 9)
            self.assertEqual(len(digest), 64)
            self.assertEqual(sha256_file(first), "fb00984bd4d2566db1f90dd91095a5ee9c8050a56ed38589a00f3665214c4824")

    def test_native_quit_addresses_exact_bundle_and_waits_for_exit(self) -> None:
        process = Mock()
        process.poll.return_value = None
        process.wait.return_value = 0
        calls = []

        def runner(command, **kwargs):
            calls.append((command, kwargs))
            return subprocess.CompletedProcess(command, 0, "")

        succeeded, detail = native_application_quit(
            Path('/tmp/Release Candidate/StudyVault.app'), process, 20, runner=runner
        )
        self.assertTrue(succeeded)
        self.assertIn("Apple event completed", detail)
        self.assertEqual(
            calls[0][0],
            ["osascript", "-e", 'tell application "/tmp/Release Candidate/StudyVault.app" to quit'],
        )
        process.wait.assert_called_once_with(timeout=20)
        process.send_signal.assert_not_called()

    def test_native_quit_failure_is_not_reported_as_normal_shutdown(self) -> None:
        process = Mock()
        process.poll.return_value = None
        failed = subprocess.CompletedProcess(["osascript"], 1, "not authorized")
        succeeded, detail = native_application_quit(
            Path("/tmp/StudyVault.app"), process, 5, runner=lambda *args, **kwargs: failed
        )
        self.assertFalse(succeeded)
        self.assertIn("not authorized", detail)
        process.wait.assert_not_called()
        process.send_signal.assert_not_called()

    def test_arm64_macho_verification_rejects_other_artifacts(self) -> None:
        good = Mock(returncode=0, stdout="Mach-O 64-bit executable arm64\n")
        self.assertIn("arm64", verify_arm64_macho(Path("StudyVault"), runner=lambda *args, **kwargs: good))
        bad = Mock(returncode=0, stdout="Mach-O 64-bit executable x86_64\n")
        with self.assertRaisesRegex(HarnessError, "arm64 Mach-O"):
            verify_arm64_macho(Path("StudyVault"), runner=lambda *args, **kwargs: bad)

    def test_process_tree_metrics_include_all_descendants(self) -> None:
        rows = parse_ps_rows(
            """
              100   1  0.5  1000 /StudyVault
              101 100  1.0  2000 /StudyVault Helper
              102 101  0.2  3000 /lsatlab-backend
              200   1 99.0  9999 /unrelated
            """
        )
        self.assertEqual(descendant_pids(rows, 100), {100, 101, 102})

    def test_network_policy_accepts_only_loopback_endpoints(self) -> None:
        accepted = (
            "127.0.0.1:8100 (LISTEN)",
            "127.0.0.1:51234->127.0.0.1:8100",
            "[::1]:5055 (LISTEN)",
            "localhost:5000->localhost:1234",
        )
        self.assertTrue(all(endpoint_is_loopback(item) for item in accepted))
        self.assertFalse(endpoint_is_loopback("*:8100 (LISTEN)"))
        self.assertFalse(endpoint_is_loopback("127.0.0.1:51234->8.8.8.8:443"))

    def test_summary_uses_aggregate_cpu_and_end_to_end_rss_growth(self) -> None:
        samples = [
            ProcessSample(0, 4, 1.0, 100_000_000),
            ProcessSample(5, 4, 2.0, 105_000_000),
            ProcessSample(10, 4, 3.0, 114_000_000),
        ]
        summary = summarize_samples(samples, Limits(idle_cpu_seconds=10, sample_interval_seconds=5))
        self.assertEqual(summary["average_idle_cpu_percent"], 2.0)
        self.assertEqual(summary["rss_growth_percent"], 14.0)
        self.assertEqual(summary["rss_peak_bytes"], 114_000_000)

    def test_isolated_environment_removes_profile_and_network_overrides(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            env, user_data = isolated_environment(Path(directory) / "isolation")
            self.assertEqual(env["HOME"], str(Path(directory) / "isolation" / "home"))
            self.assertEqual(user_data, Path(directory) / "isolation" / "user-data")
            self.assertNotIn("LSATLAB_DATA_DIR", env)
            self.assertNotIn("VITE_DEV_SERVER_URL", env)
            self.assertEqual(env["NO_PROXY"], "localhost,127.0.0.1,::1")


if __name__ == "__main__":
    unittest.main()
