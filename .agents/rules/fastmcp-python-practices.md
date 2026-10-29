---
name: fastmcp-python-practices
description: Best practices for Python FastMCP server development, avoiding namespace shadowing, and secure Nginx/Express companion architectures.
trigger:
  - fastmcp
  - mcp.py
  - python mcp
  - mcp bridge
---

# FastMCP Python Development & Security Practices

## 1. Naming & Namespace Guard
- **Never name scripts `mcp.py`**: A file named `mcp.py` in the root or working directory shadows the top-level `mcp` SDK library package (`from mcp.types import ...`), causing circular imports and `ModuleNotFoundError: No module named 'mcp.server'`.
- Always name the executable server file `fastmcp_server.py` or `mcp_server.py`.

## 2. Nginx SSE Reverse Proxying
FastMCP SSE (`transport="sse"`) requires dedicated proxy settings in Nginx:
- Expose `/sse` and `/messages/` to port `8001`.
- Disable buffering: `proxy_buffering off; proxy_cache off; chunked_transfer_encoding off;`
- Extend timeouts for long-lived streams: `proxy_read_timeout 24h; proxy_send_timeout 24h;`

## 3. Express Companion Bridge Security
When FastMCP dispatches commands to a local Node.js backend:
- **Router Scoping**: Never attach top-level auth middleware to `/api` without subpath scoping (use `r.use('/files', requireAuth)` instead of `r.use(requireAuth)`).
- **Loopback Enforcement**: Verify `req.socket.remoteAddress` is loopback (`127.0.0.1`, `::1`).
- **Internal Secret**: Require an `x-internal-secret` header between FastMCP and Node.js.
- **Nginx Gate**: Explicitly block `/api/internal/` from public requests with `return 403;`.
