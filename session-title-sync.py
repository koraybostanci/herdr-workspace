"""Keep local Herdr desktop tabs named after their agents' sessions."""

import json
import re
import signal
import subprocess
import sys
from pathlib import Path

HC = str(Path.home() / ".local/bin/hc")
APP = str(Path.home() / ".local/bin/herdr-app")


def command(*args):
    result = subprocess.run(args, capture_output=True, text=True, check=True, timeout=10)
    data = json.loads(result.stdout)
    if "error" in data:
        raise RuntimeError(str(data["error"]))
    return data


def session_title(terminal):
    status = terminal.get("status") or {}
    if terminal.get("state") != "live" or not status.get("app"):
        return None
    if status["app"] == "opencode":
        match = re.search(r"(?:^|\s)OC\s*\|\s*(.*)", terminal.get("title", ""))
        if match:
            return match[1].strip() or None
    return status.get("title", "").strip() or None


def renames(view, terminals):
    changes = []
    for space in view["spaces"]:
        if space.get("machine") is not None:
            continue
        for tab in space["tabs"]:
            for pane in tab["terminals"]:
                title = session_title(terminals.get(pane["terminal"], {}))
                if title:
                    if tab["name"] != title:
                        changes.append((tab["id"], title))
                    break
    return changes


def main():
    terminals = {}
    synced = None
    events = subprocess.Popen([HC, "events", "--json"], stdout=subprocess.PIPE, text=True)
    try:
        for line in events.stdout:
            message = json.loads(line)
            method = message.get("method")
            params = message.get("params", {})
            kind = params.get("type")
            if "terminals" in message or method == "missed":
                snapshot = params if method == "missed" else message
                terminals = {t["address"]: t for t in snapshot["terminals"]}
                synced = None
            elif method == "event" and kind == "removed":
                terminals.pop(params["terminal"], None)
            elif method == "event" and kind in {"title", "status", "created", "labels", "restarted", "finished"}:
                address = params["terminal"]
                try:
                    terminals[address] = command(HC, "get", address, "--json")
                except subprocess.CalledProcessError:
                    terminals.pop(address, None)
            elif method != "heartbeat" and not (method == "event" and kind == "doc"):
                continue

            signature = tuple(sorted((address, session_title(t), t.get("labels", {}).get("herdr.tab")) for address, t in terminals.items()))
            if signature != synced or kind == "doc":
                try:
                    for tab, title in renames(command(APP, "ls"), terminals):
                        command(APP, "do", "tab.rename", json.dumps({"id": tab, "name": title}))
                        print(f"Renamed {tab}: {title}", flush=True)
                    synced = signature
                except (subprocess.SubprocessError, RuntimeError, ValueError) as error:
                    print(f"Waiting for Herdr desktop: {error}", file=sys.stderr, flush=True)
            if "--once" in sys.argv:
                break
        else:
            raise RuntimeError("Herdr event stream disconnected")
    finally:
        events.terminate()
        events.wait(timeout=5)


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    main()
