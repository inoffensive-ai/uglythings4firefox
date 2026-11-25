#!/usr/bin/env python3
"""
Single-file WebSocket client for Browser Extension Bridge with two terminal subwindows
(top input window, bottom output window).
"""

import argparse
import asyncio
import curses
import json
import os
import shlex
import websockets


def resolve_uri(host_arg: str | None, port: int) -> str:
    if host_arg:
        host = host_arg
    elif os.environ.get("CONTAINER_MODE") in ("auto", "manual"):
        host = os.environ.get("CONTAINER_HOST") or "host.containers.internal"
    else:
        host = "127.0.0.1"
    return f"ws://{host}:{port}"


def parse_scalar(val: str):
    low = val.lower()
    if low == "true":
        return True
    if low == "false":
        return False
    if low == "null":
        return None
    try:
        return int(val)
    except ValueError:
        pass
    try:
        return float(val)
    except ValueError:
        pass
    if (val.startswith("{") and val.endswith("}")) or (val.startswith("[") and val.endswith("]")):
        try:
            return json.loads(val)
        except json.JSONDecodeError:
            pass
    return val


def build_payload(line: str) -> dict:
    raw = line.strip()
    if raw.startswith("{"):
        obj = json.loads(raw)
        if not isinstance(obj, dict):
            raise ValueError("JSON input must be an object")
        return obj

    tokens = shlex.split(raw)
    if not tokens:
        raise ValueError("empty command")

    payload: dict = {"method": tokens[0]}
    params: list = []
    for tok in tokens[1:]:
        if "=" in tok:
            k, v = tok.split("=", 1)
            payload[k] = parse_scalar(v)
        else:
            params.append(parse_scalar(tok))
    if params:
        payload["params"] = params
    return payload


class SplitTerminalUI:
    def __init__(self, stdscr, uri: str):
        self.stdscr = stdscr
        self.uri = uri
        self.out_lines: list[str] = []
        self.input_buf: list[str] = []
        self.in_win = None
        self.out_win = None
        self._build_windows()

    def _build_windows(self):
        curses.curs_set(1)
        self.stdscr.nodelay(True)
        self.stdscr.keypad(True)
        h, w = self.stdscr.getmaxyx()
        in_h = 4
        out_h = max(3, h - in_h - 1)
        self.in_win = curses.newwin(in_h, w, 0, 0)
        self.in_win.keypad(True)
        self.in_win.nodelay(True)
        self.out_win = curses.newwin(out_h, w, in_h + 1, 0)
        self.out_win.nodelay(True)
        self._redraw_all()

    def _redraw_all(self):
        h, w = self.stdscr.getmaxyx()
        in_h = 4
        out_h = max(3, h - in_h - 1)

        self.stdscr.erase()
        self.stdscr.hline(in_h, 0, curses.ACS_HLINE, w)
        self.stdscr.noutrefresh()

        self.out_win.erase()
        self.out_win.box()
        self.out_win.addstr(0, 2, " OUTPUT (RESPONSES & PUSH EVENTS) ")
        inner_h = max(1, out_h - 2)
        inner_w = max(1, w - 4)
        visible = self.out_lines[-inner_h:]
        for idx, line in enumerate(visible):
            self.out_win.addnstr(1 + idx, 2, line, inner_w)
        self.out_win.noutrefresh()

        self.in_win.erase()
        self.in_win.box()
        self.in_win.addstr(0, 2, f" INPUT ({self.uri}) - Enter: send | Ctrl+C: quit ")
        prompt = "> " + "".join(self.input_buf)
        max_txt = max(1, w - 4)
        shown = prompt[-max_txt:]
        self.in_win.addstr(1, 2, shown)
        cursor_x = min(w - 3, 2 + len(shown))
        self.in_win.move(1, cursor_x)
        self.in_win.noutrefresh()

        curses.doupdate()

    def append_output(self, text: str):
        for line in str(text).splitlines() or [""]:
            self.out_lines.append(line)
        if len(self.out_lines) > 2000:
            self.out_lines = self.out_lines[-2000:]
        self._redraw_all()

    def poll_key(self) -> str | None:
        ch = self.in_win.getch()
        if ch == -1:
            return None
        if ch == curses.KEY_RESIZE:
            self._build_windows()
            return None
        if ch in (10, 13, curses.KEY_ENTER):
            cmd = "".join(self.input_buf).strip()
            self.input_buf.clear()
            self._redraw_all()
            return cmd
        if ch in (curses.KEY_BACKSPACE, 127, 8):
            if self.input_buf:
                self.input_buf.pop()
                self._redraw_all()
            return None
        if 32 <= ch <= 126:
            self.input_buf.append(chr(ch))
            self._redraw_all()
        return None


async def run_client(stdscr, uri: str):
    ui = SplitTerminalUI(stdscr, uri)
    ui.append_output(f"[INFO] Connecting to {uri}...")

    stop_event = asyncio.Event()

    async def ws_task():
        while not stop_event.is_set():
            try:
                async with websockets.connect(uri, max_size=None) as ws:
                    ui.append_output(f"[CONNECTED] {uri}")
                    send_queue: asyncio.Queue[str] = asyncio.Queue()

                    async def writer():
                        while not stop_event.is_set():
                            raw_cmd = await send_queue.get()
                            try:
                                payload = build_payload(raw_cmd)
                                encoded = json.dumps(payload)
                                await ws.send(encoded)
                                ui.append_output(f"[SENT] {encoded}")
                            except Exception as exc:
                                ui.append_output(f"[ERR] {exc}")

                    async def reader():
                        async for msg in ws:
                            try:
                                parsed = json.loads(msg)
                                ui.append_output(f"[RECV]\n{json.dumps(parsed, indent=2, ensure_ascii=False)}")
                            except json.JSONDecodeError:
                                ui.append_output(f"[RECV] {msg}")

                    async def input_poller():
                        while not stop_event.is_set():
                            cmd = ui.poll_key()
                            if cmd is not None:
                                if cmd in ("quit", "exit"):
                                    stop_event.set()
                                    return
                                if cmd:
                                    await send_queue.put(cmd)
                            await asyncio.sleep(0.02)

                    tasks = [
                        asyncio.create_task(writer()),
                        asyncio.create_task(reader()),
                        asyncio.create_task(input_poller()),
                    ]
                    done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                    for p in pending:
                        p.cancel()
                    await asyncio.gather(*pending, return_exceptions=True)
                    for d in done:
                        if not d.cancelled() and d.exception():
                            raise d.exception()
            except asyncio.CancelledError:
                break
            except Exception as exc:
                if stop_event.is_set():
                    break
                ui.append_output(f"[DISCONNECTED] {exc} (retrying in 1s)")
                await asyncio.sleep(1.0)

    await ws_task()


def main():
    parser = argparse.ArgumentParser(description="Single-file split-window WebSocket bridge client")
    parser.add_argument("--host", default=None)
    parser.add_argument("--port", type=int, default=8767)
    args = parser.parse_args()
    uri = resolve_uri(args.host, args.port)

    def _curses_entry(stdscr):
        try:
            asyncio.run(run_client(stdscr, uri))
        except KeyboardInterrupt:
            pass

    curses.wrapper(_curses_entry)


if __name__ == "__main__":
    main()
