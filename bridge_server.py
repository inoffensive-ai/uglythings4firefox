import socket, threading, json

HOST = "0.0.0.0"
PORT = 8765

# Extension exposes these via runtime.onMessage (see bg.js)
EXT_MESSAGES = {
    "getTabs":   lambda m: {"method": "getTabs", "params": []},
    "navigate":  lambda m: {"method": "navigate", "params": [m.get("url")]},
    "getDom":    lambda m: {"method": "getDom", "params": []},
}

def handle(msg):
    handler = EXT_MESSAGES.get(msg.get("type"))
    if not handler:
        return {"ok": False, "error": "unknown type"}
    # Return a request object the extension's bg.js will receive.
    return {"ok": True, "forward": handler(msg)}

def handle_conn(conn):
    try:
        while True:
            line = conn.makefile("r").readline()
            if not line:
                break
            msg = json.loads(line.strip())
            resp = (json.dumps(handle(msg)) + "\n").encode()
            conn.sendall(resp)
    except Exception as e:
        print("error:", e)
    finally:
        conn.close()

def main():
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind((HOST, PORT))
    server.listen(5)
    print(f"[+] Bridge listening on {HOST}:{PORT}")
    while True:
        conn, addr = server.accept()
        threading.Thread(target=handle_conn, args=(conn,), daemon=True).start()

if __name__ == "__main__":
    main()
