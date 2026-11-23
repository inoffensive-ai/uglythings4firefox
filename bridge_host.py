#!/usr/bin/env python3
import json
import socket
import struct
import sys
import threading

HOST = "127.0.0.1"
PORT = 8766

io_lock = threading.Lock()
pending_lock = threading.Lock()
pending = {}
next_id = 0


def read_native_msg():
    raw_len = sys.stdin.buffer.read(4)
    if len(raw_len) < 4:
        return None
    (msg_len,) = struct.unpack("=I", raw_len)
    data = sys.stdin.buffer.read(msg_len)
    if len(data) < msg_len:
        return None
    return json.loads(data.decode("utf-8"))


def send_native_msg(obj):
    raw = json.dumps(obj).encode("utf-8")
    with io_lock:
        sys.stdout.buffer.write(struct.pack("=I", len(raw)))
        sys.stdout.buffer.write(raw)
        sys.stdout.buffer.flush()


def reader_loop():
    while True:
        msg = read_native_msg()
        if msg is None:
            break
        req_id = msg.get("requestId")
        if req_id is None:
            continue
        with pending_lock:
            entry = pending.get(req_id)
        if entry is not None:
            entry["response"] = msg
            entry["event"].set()


def handle_client(conn):
    global next_id
    try:
        rfile = conn.makefile("r", encoding="utf-8")
        for line in rfile:
            line = line.strip()
            if not line:
                continue
            cmd = json.loads(line)
            with pending_lock:
                next_id += 1
                req_id = next_id
                ev = threading.Event()
                entry = {"event": ev, "response": None}
                pending[req_id] = entry
            try:
                payload = dict(cmd)
                payload["requestId"] = req_id
                send_native_msg(payload)
                if not ev.wait(timeout=10):
                    resp = {"ok": False, "error": "native host timeout"}
                else:
                    resp = entry["response"]
            finally:
                with pending_lock:
                    pending.pop(req_id, None)
            conn.sendall((json.dumps(resp) + "\n").encode("utf-8"))
    except Exception as exc:
        try:
            conn.sendall((json.dumps({"ok": False, "error": str(exc)}) + "\n").encode("utf-8"))
        except OSError:
            pass
    finally:
        conn.close()


def main():
    threading.Thread(target=reader_loop, daemon=True).start()
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((HOST, PORT))
    srv.listen(8)
    while True:
        conn, _ = srv.accept()
        threading.Thread(target=handle_client, args=(conn,), daemon=True).start()


if __name__ == "__main__":
    main()
