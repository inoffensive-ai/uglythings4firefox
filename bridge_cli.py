#!/usr/bin/env python3
"""
WebSocket CLI for Browser Extension Bridge (ports 8767 default).

Modes:
  --mode send : interactive command prompt (sends JSON/method commands over WS)
  --mode recv : live stream of server responses and pushed/broadcast events
"""

import argparse
import asyncio
import json
import os
import shlex
import sys
import websockets


def resolve_endpoint(host_arg: str | None, port: int) -> str:
    if host_arg:
        host = host_arg
    elif os.environ.get("CONTAINER_MODE") in ("auto", "manual"):
        host = os.environ.get("CONTAINER_HOST") or "host.containers.internal"
    else:
        host = "127.0.0.1"
    return f"ws://{host}:{port}"


def parse_scalar(val: str):
    if val.lower() == "true":
        return True
    if val.lower() == "false":
        return False
    if val.lower() == "null":
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

    method = tokens[0]
    payload: dict = {"method": method}
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


async def recv_loop(uri: str) -> None:
    while True:
        try:
            async with websockets.connect(uri, max_size=None) as ws:
                print(f"[RECV] connected to {uri}", flush=True)
                async for msg in ws:
                    try:
                        parsed = json.loads(msg)
                        print(json.dumps(parsed, indent=2, ensure_ascii=False), flush=True)
                    except json.JSONDecodeError:
                        print(msg, flush=True)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            print(f"[RECV] disconnected ({exc}); reconnecting in 1s...", flush=True)
            await asyncio.sleep(1.0)


async def send_loop(uri: str) -> None:
    loop = asyncio.get_running_loop()
    async with websockets.connect(uri, max_size=None) as ws:
        print(f"[SEND] connected to {uri}. Type commands or 'quit'.", flush=True)
        while True:
            line = await loop.run_in_executor(None, sys.stdin.readline)
            if not line:
                break
            cmd_text = line.strip()
            if not cmd_text:
                continue
            if cmd_text in ("quit", "exit"):
                break
            try:
                payload = build_payload(cmd_text)
                await ws.send(json.dumps(payload))
                print(f"[SENT] {json.dumps(payload)}", flush=True)
            except Exception as exc:
                print(f"[ERR] {exc}", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="Browser bridge WebSocket CLI")
    parser.add_argument("--mode", choices=["send", "recv"], required=True)
    parser.add_argument("--host", default=None)
    parser.add_argument("--port", type=int, default=8767)
    args = parser.parse_args()

    uri = resolve_endpoint(args.host, args.port)
    coro = send_loop(uri) if args.mode == "send" else recv_loop(uri)
    try:
        asyncio.run(coro)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()