"""Run with: python3 -m unittest discover -s spike/mitmproxy -p '*_test.py'

Imported without mitmproxy present, so only the pure functions are covered.
Everything that touches a flow is exercised by spike/netns/lima-fenced.sh.
"""

import json
import os
import sys
import tempfile
import unittest
from unittest import mock

sys.modules.setdefault("mitmproxy", mock.MagicMock())
for name in ("http", "tcp", "tls"):
    sys.modules.setdefault(f"mitmproxy.{name}", mock.MagicMock())

import verdict  # noqa: E402


class Matching(unittest.TestCase):
    def test_an_empty_allow_list_reaches_anything(self):
        self.assertTrue(verdict.matches([], "anywhere.example"))

    def test_a_listed_domain_is_reached_and_its_subdomains_with_it(self):
        self.assertTrue(verdict.matches(["example.com"], "example.com"))
        self.assertTrue(verdict.matches(["example.com"], "files.example.com"))

    def test_a_suffix_match_stops_at_a_label_boundary(self):
        self.assertFalse(verdict.matches(["example.com"], "notexample.com"))

    def test_case_and_a_trailing_dot_do_not_change_the_answer(self):
        self.assertTrue(verdict.matches(["Example.COM"], "files.example.com."))

    def test_an_unlisted_domain_does_not_match(self):
        self.assertFalse(verdict.matches(["example.com"], "elsewhere.example"))


class Deciding(unittest.TestCase):
    def test_without_enforcement_a_denial_is_only_recorded(self):
        policy = {"allow": ["example.com"], "enforce": False}
        self.assertEqual(verdict.decide(policy, "elsewhere.example"), "report")
        self.assertEqual(verdict.decide(policy, "example.com"), "allow")

    def test_with_enforcement_a_denial_is_a_denial(self):
        policy = {"allow": ["example.com"], "enforce": True}
        self.assertEqual(verdict.decide(policy, "elsewhere.example"), "deny")

    def test_a_policy_that_forgot_to_say_enforces(self):
        self.assertEqual(verdict.decide({"allow": ["example.com"]}, "elsewhere.example"), "deny")

    def test_a_policy_that_forgot_its_allow_list_reaches_anything(self):
        self.assertEqual(verdict.decide({"enforce": True}, "anywhere.example"), "allow")


class Reading(unittest.TestCase):
    def read(self, contents):
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            if contents is not None:
                f.write(contents)
            path = f.name
        self.addCleanup(os.unlink, path)
        with mock.patch.object(verdict, "POLICY", path):
            return verdict.verdict("elsewhere.example")

    def test_a_readable_policy_is_applied(self):
        got = self.read(json.dumps({"allow": ["example.com"], "enforce": True}))
        self.assertEqual(got, "deny")

    def test_an_unparseable_policy_denies(self):
        self.assertEqual(self.read("{not json"), "deny")

    def test_a_policy_that_is_not_an_object_denies(self):
        self.assertEqual(self.read("[]"), "deny")

    def test_an_empty_policy_file_denies(self):
        self.assertEqual(self.read(""), "deny")

    def test_a_missing_policy_denies(self):
        with mock.patch.object(verdict, "POLICY", "/nonexistent/policy.json"):
            self.assertEqual(verdict.verdict("example.com"), "deny")


if __name__ == "__main__":
    unittest.main()
