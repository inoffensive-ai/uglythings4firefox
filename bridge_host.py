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