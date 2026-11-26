#!/usr/bin/env python3
"""
Browser Extension Bridge Host.

Native-messaging bridge to bg.js (4-byte length prefix + JSON over stdin/stdout),
with a TCP line-delimited relay on HOST:PORT and a WebSocket server + fan-out on
HOST:WS_PORT.
"""

import asyncio
import json
import socket
import struct
import sys
import threading

from websockets.asyncio.server import serve as ws_serve

HOST = "0.0.0.0"
PORT = 8766
WS_PORT = 8767
RPC_TIMEOUT = 10.0
FILTER_RPC_ECHOES = True
MAX_NATIVE_MSG_BYTES = 900_000
MAX_OUTBOUND_NATIVE_BYTES = 900_000

io_lock = threading.Lock()
pending_lock = threading.Lock()
pending = {}
next_id = 0

clients = set()
clients_lock = threading.Lock()

main_loop = None


def log_err(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def register_client(ws):
    with clients_lock:
        clients.add(ws)


def unregister_client(ws):
    with clients_lock:
        clients.discard(ws)


def schedule_broadcast(payload):
    if main_loop is None or main_loop.is_closed():
        return
    asyncio.run_coroutine_threadsafe(broadcast(payload), main_loop)


async def broadcast(payload):
    with clients_lock:
        alive = list(clients)
    if not alive:
        return
    encoded = json.dumps(payload)
    await asyncio.gather(*(c.send(encoded) for c in alive), return_exceptions=True)


def sanitize_for_broadcast(msg):
    if not isinstance(msg, dict):
        return msg
    clean = dict(msg)
    for key in ("rawBase64", "rawText", "html"):
        if key in clean:
            clean[key] = "<omitted>"
    if isinstance(clean.get("network"), dict) and "requests" in clean["network"]:
        clean["network"] = {
            **clean["network"],
            "requests": f"<{len(clean['network']['requests'])} requests omitted>",
        }
    encoded = json.dumps(clean).encode("utf-8")
    if len(encoded) > MAX_NATIVE_MSG_BYTES:
        return {
            "event": "oversized_payload_dropped",
            "bytes": len(encoded),
            "requestId": clean.get("requestId"),
        }
    return clean


def read_native_msg():
    raw_len = sys.stdin.buffer.read(4)
    if len(raw_len) < 4:
        return None
    (msg_len,) = struct.unpack("=I", raw_len)
    if msg_len > MAX_NATIVE_MSG_BYTES:
        log_err(f"[NATIVE_IN] oversized frame header ({msg_len} bytes); discarding stream")
        return None
    data = sys.stdin.buffer.read(msg_len)
    if len(data) < msg_len:
        return None
    return json.loads(data.decode("utf-8"))


def send_native_msg(obj):
    raw = json.dumps(obj).encode("utf-8")
    log_err(f"[NATIVE_OUT] req_id={obj.get('requestId')} bytes={len(raw)}")
    if len(raw) > MAX_OUTBOUND_NATIVE_BYTES:
        err_obj = {
            "requestId": obj.get("requestId"),
            "ok": False,
            "error": f"outbound native message too large ({len(raw)} bytes)",
        }
        raw = json.dumps(err_obj).encode("utf-8")
    with io_lock:
        sys.stdout.buffer.write(struct.pack("=I", len(raw)))
        sys.stdout.buffer.write(raw)
        sys.stdout.buffer.flush()


def create_pending_entry():
    global next_id
    with pending_lock:
        next_id += 1
        req_id = next_id
        ev = threading.Event()
        entry = {"event": ev, "response": None}
        pending[req_id] = entry
    return req_id, ev, entry


def pop_pending_entry(req_id):
    with pending_lock:
        return pending.pop(req_id, None)


def send_rpc_sync(cmd, timeout=RPC_TIMEOUT):
    if not isinstance(cmd, dict):
        raise ValueError("command must be a JSON object")
    req_id, ev, entry = create_pending_entry()
    try:
        payload = dict(cmd)
        payload["requestId"] = req_id
        send_native_msg(payload)
        if not ev.wait(timeout=timeout):
            return {"ok": False, "error": "native host timeout"}
        resp = entry["response"]
        return resp if resp is not None else {"ok": False, "error": "empty native response"}
    finally:
        pop_pending_entry(req_id)


def reader_loop():
    while True:
        try:
            msg = read_native_msg()
            if msg is None:
                log_err("[NATIVE_IN] EOF or oversized frame; reader_loop exiting")
                break
            req_id = msg.get("requestId") if isinstance(msg, dict) else None
            matched = False
            if req_id is not None:
                with pending_lock:
                    entry = pending.get(req_id)
                if entry is not None:
                    entry["response"] = msg
                    entry["event"].set()
                    matched = True

            if matched and FILTER_RPC_ECHOES and isinstance(msg, dict) and "result" in msg:
                continue
            schedule_broadcast(sanitize_for_broadcast(msg))
        except Exception as exc:
            log_err(f"[NATIVE_IN] error: {exc}")


def handle_client(conn, addr):
    try:
        with conn:
            rfile = conn.makefile("r", encoding="utf-8")
            for line in rfile:
                line = line.strip()
                if not line:
                    continue
                try:
                    cmd = json.loads(line)
                    resp = send_rpc_sync(cmd)
                except Exception as exc:
                    resp = {"ok": False, "error": str(exc)}
                conn.sendall((json.dumps(resp) + "\n").encode("utf-8"))
    except OSError:
        pass


def tcp_server_loop():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as srv:
        srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        srv.bind((HOST, PORT))
        srv.listen()
        log_err(f"TCP relay listening on {HOST}:{PORT}")
        while True:
            conn, addr = srv.accept()
            threading.Thread(target=handle_client, args=(conn, addr), daemon=True).start()


async def handler(connection):
    register_client(connection)
    try:
        async for message in connection:
            try:
                cmd = json.loads(message)
                resp = await asyncio.to_thread(send_rpc_sync, cmd)
                await connection.send(json.dumps(resp))
            except Exception as exc:
                try:
                    await connection.send(json.dumps({"ok": False, "error": str(exc)}))
                except Exception:
                    break
    finally:
        unregister_client(connection)


async def main():
    global main_loop
    main_loop = asyncio.get_running_loop()

    threading.Thread(target=tcp_server_loop, daemon=True).start()
    threading.Thread(target=reader_loop, daemon=True).start()

    async with ws_serve(handler, HOST, WS_PORT):
        log_err(f"WS server listening on ws://{HOST}:{WS_PORT}")
        await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
