#!/usr/bin/env python3
"""Mcode relay forwarder — a minimal TCP port forwarder for the VPS.

Bridges a public port (where the phone connects) to the SSH reverse-tunnel's
localhost binding. This script is uploaded to the VPS via SFTP and started
with nohup when `socat` is not available. Pure stdlib, zero dependencies.

Usage:
    python3 forwarder.py <listen_port> <target_port> [<listen_host> <target_host>]

Defaults: listen on 0.0.0.0, target 127.0.0.1.
"""
import socket
import sys
import threading

LISTEN_HOST = "0.0.0.0"
LISTEN_PORT = 7331
TARGET_HOST = "127.0.0.1"
TARGET_PORT = 17891


def parse_args():
    global LISTEN_HOST, LISTEN_PORT, TARGET_HOST, TARGET_PORT
    if len(sys.argv) >= 3:
        LISTEN_PORT = int(sys.argv[1])
        TARGET_PORT = int(sys.argv[2])
    if len(sys.argv) >= 4:
        LISTEN_HOST = sys.argv[3]
    if len(sys.argv) >= 5:
        TARGET_HOST = sys.argv[4]


def pipe(src, dst):
    """Bidirectionally forward data between two sockets until one closes."""
    try:
        while True:
            data = src.recv(65536)
            if not data:
                break
            dst.sendall(data)
    except Exception:
        pass
    finally:
        for s in (src, dst):
            try:
                s.close()
            except Exception:
                pass


def handle(client):
    """Connect to the target and start bidirectional forwarding."""
    try:
        remote = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        remote.settimeout(5)
        remote.connect((TARGET_HOST, TARGET_PORT))
        remote.settimeout(None)
        threading.Thread(target=pipe, args=(client, remote), daemon=True).start()
        threading.Thread(target=pipe, args=(remote, client), daemon=True).start()
    except Exception:
        try:
            client.close()
        except Exception:
            pass


def main():
    parse_args()
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind((LISTEN_HOST, LISTEN_PORT))
    server.listen(32)
    while True:
        try:
            client, _ = server.accept()
            threading.Thread(target=handle, args=(client,), daemon=True).start()
        except Exception:
            continue


if __name__ == "__main__":
    main()
