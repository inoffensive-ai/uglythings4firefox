import json
import socket
import sys

HOST = "127.0.0.1"
PORT = 8766


def call(msg):
    s = socket.create_connection((HOST, PORT), timeout=5)
    payload = (json.dumps(msg) + "\n").encode()
    s.sendall(payload)
    buf = b""
    while b"\n" not in buf:
        chunk = s.recv(4096)
        if not chunk:
            break
        buf += chunk
    line, _, _ = buf.partition(b"\n")
    s.close()
    return json.loads(line.decode().strip())


if len(sys.argv) > 1:
    msg = {"type": sys.argv[1], **{k: v for k, v in (x.split("=") for x in sys.argv[2:])}}
else:
    msg = {"type": "getTabs"}
print(json.dumps(call(msg), indent=2))
