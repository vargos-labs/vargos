"""Use the existing Vargos newline-delimited JSON-RPC gateway."""
import json
import os
import socket


def call(method, params=None):
    address = (os.environ["VARGOS_RPC_HOST"], int(os.environ["VARGOS_RPC_PORT"]))
    with socket.create_connection(address, timeout=10) as connection:
        request = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}}
        connection.sendall((json.dumps(request) + "\n").encode())
        with connection.makefile("rb") as stream:
            response = json.loads(stream.readline())
    if response.get("id") != 1:
        raise RuntimeError("Unexpected Vargos RPC response")
    if "error" in response:
        raise RuntimeError(response["error"].get("message", "Vargos RPC failed"))
    return response["result"]
