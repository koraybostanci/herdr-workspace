import importlib.util
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "session-title-sync.py"
spec = importlib.util.spec_from_file_location("session_title_sync", SCRIPT)
bridge = importlib.util.module_from_spec(spec)
if SCRIPT.exists():
    spec.loader.exec_module(bridge)


def terminal(title="OC | configure-herdr", app="opencode", state="live", reported_title=""):
    return {"state": state, "title": title, "status": {"app": app, "title": reported_title}}


class SessionTitleSyncTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(hasattr(bridge, "session_title"), "Session-title bridge is not implemented")

    def test_opencode_prefix_is_removed(self):
        self.assertEqual(bridge.session_title(terminal()), "configure-herdr")

    def test_title_changes_follow_the_current_session(self):
        self.assertEqual(bridge.session_title(terminal("OC | renamed-session")), "renamed-session")

    def test_title_punctuation_is_preserved(self):
        self.assertEqual(bridge.session_title(terminal("OC | [PROJ-101] user@example.org")), "[PROJ-101] user@example.org")

    def test_activity_glyph_is_not_part_of_the_session_name(self):
        self.assertEqual(bridge.session_title(terminal("⠋ OC | configure-herdr")), "configure-herdr")

    def test_explicit_reported_title_is_a_fallback(self):
        self.assertEqual(bridge.session_title(terminal("OpenCode", reported_title="configure-herdr")), "configure-herdr")

    def test_shells_finished_agents_and_empty_titles_are_ignored(self):
        for record in [terminal(app=""), terminal(state="finished"), terminal("OC | "), terminal("OpenCode"), terminal("~/dev/github")]:
            with self.subTest(record=record):
                self.assertIsNone(bridge.session_title(record))

    def test_other_agents_can_supply_an_explicit_session_title(self):
        self.assertEqual(bridge.session_title(terminal("Claude Code", app="claude-code", reported_title="Review auth")), "Review auth")

    def test_each_session_renames_its_own_tab_and_shells_stay_unchanged(self):
        view = {"spaces": [{"machine": None, "tabs": [
            {"id": "tab-1", "name": "1", "terminals": [{"terminal": "t2"}]},
            {"id": "tab-2", "name": "2", "terminals": [{"terminal": "t3"}]},
            {"id": "tab-3", "name": "cmd", "terminals": [{"terminal": "t8"}]},
            {"id": "tab-4", "name": "4", "terminals": [{"terminal": "t9"}]},
        ]}]}
        records = {"t2": terminal("OC | proj-101-pr4-gtm"), "t3": terminal("OC | telekom-vs-congstar"), "t8": terminal(), "t9": terminal(app="")}
        self.assertEqual(bridge.renames(view, records), [("tab-1", "proj-101-pr4-gtm"), ("tab-2", "telekom-vs-congstar"), ("tab-3", "configure-herdr")])

    def test_already_matching_tabs_are_not_renamed(self):
        view = {"spaces": [{"machine": None, "tabs": [{"id": "tab-1", "name": "configure-herdr", "terminals": [{"terminal": "t8"}]}]}]}
        self.assertEqual(bridge.renames(view, {"t8": terminal()}), [])

    def test_remote_spaces_and_unknown_terminals_are_not_renamed(self):
        view = {"spaces": [
            {"machine": "devbox", "tabs": [{"id": "tab-1", "name": "1", "terminals": [{"terminal": "t8"}]}]},
            {"machine": None, "tabs": [{"id": "tab-2", "name": "2", "terminals": [{"terminal": "missing"}]}]},
        ]}
        self.assertEqual(bridge.renames(view, {"t8": terminal()}), [])

    def test_split_tabs_use_the_first_agent_in_pane_order(self):
        view = {"spaces": [{"machine": None, "tabs": [{"id": "tab-1", "name": "1", "terminals": [{"terminal": "shell"}, {"terminal": "first"}, {"terminal": "second"}]}]}]}
        records = {"shell": terminal(app=""), "first": terminal("OC | first-session"), "second": terminal("OC | second-session")}
        self.assertEqual(bridge.renames(view, records), [("tab-1", "first-session")])


if __name__ == "__main__":
    unittest.main()
