"""
Phone Remote - FastMCP Server (Python)
Full-featured FastMCP implementation of the Phone Remote agent protocol.
100% parity with mcp.js, compressed with automatic schema generation and type safety.
"""

import os
import sys
import json
import httpx
from typing import Optional, List, Dict, Any, Union
from fastmcp.server.server import FastMCP
from mcp.types import ImageContent, TextContent

BACKEND_URL = os.environ.get("BACKEND_URL", "http://127.0.0.1:3000").rstrip("/")
JWT_TOKEN = os.environ.get("JWT_TOKEN", "")
INTERNAL_BRIDGE_SECRET = os.environ.get("INTERNAL_BRIDGE_SECRET", "phone-remote-internal-bridge-secret-key-2026")

# Initialize FastMCP server
mcp = FastMCP("phone-remote", instructions="Phone Remote FastMCP Server for controlling Android devices")

def _get_auth_header() -> Optional[str]:
    try:
        from fastmcp.server.dependencies import get_http_request
        req = get_http_request()
        if req and "authorization" in req.headers:
            return req.headers["authorization"]
    except Exception:
        pass
    if JWT_TOKEN:
        return f"Bearer {JWT_TOKEN}"
    return None

async def call_backend(tool_name: str, args: dict) -> Any:
    """Dispatches tool execution to the local Node.js device signaling backend."""
    # Strip None values
    clean_args = {k: v for k, v in args.items() if v is not None}
    headers = {
        "Content-Type": "application/json",
        "x-internal-secret": INTERNAL_BRIDGE_SECRET
    }
    auth = _get_auth_header()
    if auth:
        headers["Authorization"] = auth

    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(
                f"{BACKEND_URL}/api/internal/call-tool",
                json={"name": tool_name, "args": clean_args},
                headers=headers
            )
            if resp.status_code != 200:
                return f"Error ({resp.status_code}): {resp.text}"
            
            data = resp.json()
            content_list = data.get("content", [])
            results = []
            for item in content_list:
                if item.get("type") == "image":
                    results.append(ImageContent(
                        type="image",
                        data=item.get("data", ""),
                        mimeType=item.get("mimeType", "image/jpeg")
                    ))
                elif item.get("type") == "text":
                    results.append(item.get("text", ""))

            if not results:
                return "Action executed successfully."
            if len(results) == 1:
                return results[0]
            return results
    except Exception as e:
        return f"Backend call failed: {str(e)}"


# ---------------------------------------------------------------------------
# Device Inspection & Health Tools
# ---------------------------------------------------------------------------

@mcp.tool(name="list_devices", description="List the Android phones linked to this account, with online/offline status and (when online) live screen resolution.")
async def list_devices() -> Any:
    return await call_backend("list_devices", {})


@mcp.tool(name="get_location", description="Get the most recent known GPS location of a device. Returns the cached last fix — may be a few minutes old.")
async def get_location(deviceId: str) -> Any:
    return await call_backend("get_location", {"deviceId": deviceId})


@mcp.tool(name="get_device_status", description="Check a device's health before acting on it: battery level, whether the screen is on, whether the Accessibility Service is enabled, foreground app, and network type.")
async def get_device_status(deviceId: str) -> Any:
    return await call_backend("get_device_status", {"deviceId": deviceId})


@mcp.tool(name="get_foreground_app", description="Get the package name of the app currently on screen (e.g. com.whatsapp).")
async def get_foreground_app(deviceId: str) -> Any:
    return await call_backend("get_foreground_app", {"deviceId": deviceId})


@mcp.tool(name="get_ui_tree", description="Read the screen as structured data instead of an image: every visible text, button and input field, with the normalized x/y you can pass straight to tap.")
async def get_ui_tree(deviceId: str, all: bool = False, filter: str = "") -> Any:
    return await call_backend("get_ui_tree", {"deviceId": deviceId, "all": all, "filter": filter})


@mcp.tool(name="wait_for", description="Wait until something appears on screen, then return. Polls the UI tree. Give exactly one of text, id, or app.")
async def wait_for(
    deviceId: str,
    text: Optional[str] = None,
    id: Optional[str] = None,
    app: Optional[str] = None,
    gone: bool = False,
    timeout: float = 10.0,
    screenshot: bool = False
) -> Any:
    return await call_backend("wait_for", {
        "deviceId": deviceId,
        "text": text,
        "id": id,
        "app": app,
        "gone": gone,
        "timeout": timeout,
        "screenshot": screenshot
    })


@mcp.tool(name="list_apps", description="List every app installed on the phone, with display name and package name.")
async def list_apps(deviceId: str, filter: str = "") -> Any:
    return await call_backend("list_apps", {"deviceId": deviceId, "filter": filter})


# ---------------------------------------------------------------------------
# Interaction & Navigation Tools
# ---------------------------------------------------------------------------

@mcp.tool(name="take_screenshot", description="Capture and return the current screen of a device as a JPEG image.")
async def take_screenshot(deviceId: str) -> Any:
    return await call_backend("take_screenshot", {"deviceId": deviceId})


@mcp.tool(name="tap", description="Tap the screen at a point. Coordinates are normalized 0.0-1.0 (fraction of screen width/height), not pixels — e.g. x=0.5, y=0.5 is the center.")
async def tap(deviceId: str, x: float, y: float, screenshot: bool = False) -> Any:
    return await call_backend("tap", {"deviceId": deviceId, "x": x, "y": y, "screenshot": screenshot})


@mcp.tool(name="long_press", description="Press and hold at a point — opens context menus, enters selection/edit mode, moves icons. Coordinates are normalized 0.0-1.0.")
async def long_press(deviceId: str, x: float, y: float, ms: int = 700, screenshot: bool = False) -> Any:
    return await call_backend("long_press", {"deviceId": deviceId, "x": x, "y": y, "ms": ms, "screenshot": screenshot})


@mcp.tool(name="swipe", description="Swipe from one point to another with precise normalized coordinates (0.0-1.0).")
async def swipe(deviceId: str, x1: float, y1: float, x2: float, y2: float, ms: int = 300, screenshot: bool = False) -> Any:
    return await call_backend("swipe", {"deviceId": deviceId, "x1": x1, "y1": y1, "x2": x2, "y2": y2, "ms": ms, "screenshot": screenshot})


@mcp.tool(name="scroll", description="Scroll the screen in a direction ('up', 'down', 'left', 'right'). Direction is where the content moves.")
async def scroll(deviceId: str, direction: str, amount: float = 0.6, screenshot: bool = False) -> Any:
    return await call_backend("scroll", {"deviceId": deviceId, "direction": direction, "amount": amount, "screenshot": screenshot})


@mcp.tool(name="type_text", description="Type text into the currently focused input field. Set submit:true to press Enter. Use method:'paste' as fallback.")
async def type_text(deviceId: str, text: str, method: str = "set", submit: bool = False, screenshot: bool = False) -> Any:
    return await call_backend("type_text", {"deviceId": deviceId, "text": text, "method": method, "submit": submit, "screenshot": screenshot})


@mcp.tool(name="press_key", description="Press a system key or button ('back', 'home', 'recents', 'enter', 'delete', 'notifications', 'quick_settings', 'lock', 'volume_up', 'volume_down').")
async def press_key(deviceId: str, key: str, screenshot: bool = False) -> Any:
    return await call_backend("press_key", {"deviceId": deviceId, "key": key, "screenshot": screenshot})


@mcp.tool(name="open_app", description="Open an app on the device by name (e.g. 'YouTube', 'Settings') or by exact package name.")
async def open_app(deviceId: str, name: str = "", package: str = "", screenshot: bool = True) -> Any:
    return await call_backend("open_app", {"deviceId": deviceId, "name": name, "package": package, "screenshot": screenshot})


@mcp.tool(name="open_app_drawer", description="Go to the home screen and open the app drawer (swipe up from the bottom).")
async def open_app_drawer(deviceId: str, screenshot: bool = True) -> Any:
    return await call_backend("open_app_drawer", {"deviceId": deviceId, "screenshot": screenshot})


@mcp.tool(name="open_url", description="Open a URL or app deep link on the phone (https://…, tel:, mailto:, geo:, or an app scheme like whatsapp://).")
async def open_url(deviceId: str, url: str, screenshot: bool = True) -> Any:
    return await call_backend("open_url", {"deviceId": deviceId, "url": url, "screenshot": screenshot})


@mcp.tool(name="wait", description="Pause for a few seconds to let the screen finish loading or animating before the next action.")
async def wait(deviceId: str, seconds: float = 1.5, screenshot: bool = False) -> Any:
    return await call_backend("wait", {"deviceId": deviceId, "seconds": seconds, "screenshot": screenshot})


# ---------------------------------------------------------------------------
# Device Hardware & Notification Tools
# ---------------------------------------------------------------------------

@mcp.tool(name="ring", description="Play a ringtone on the device at full volume, even in silent mode — useful for locating a lost phone.")
async def ring(deviceId: str) -> Any:
    return await call_backend("ring", {"deviceId": deviceId})


@mcp.tool(name="flash_light", description="Blink the device's camera flash a few times.")
async def flash_light(deviceId: str, count: int = 3) -> Any:
    return await call_backend("flash_light", {"deviceId": deviceId, "count": count})


@mcp.tool(name="read_notifications", description="Read the phone's notifications — currently showing ones plus a short history of recent ones (OTP, messages, alerts).")
async def read_notifications(deviceId: str, filter: str = "", limit: int = 20) -> Any:
    return await call_backend("read_notifications", {"deviceId": deviceId, "filter": filter, "limit": limit})


# ---------------------------------------------------------------------------
# File Management & Transfer Tools
# ---------------------------------------------------------------------------

@mcp.tool(name="list_files", description="List files and folders in a directory of the device's shared storage under /storage/emulated/0.")
async def list_files(deviceId: str, path: str = "/") -> Any:
    return await call_backend("list_files", {"deviceId": deviceId, "path": path})


@mcp.tool(name="get_file", description="Fetch a file FROM the phone. Returns a one-time secure download URL (valid for 10 minutes, max 100 MB).")
async def get_file(deviceId: str, path: str) -> Any:
    return await call_backend("get_file", {"deviceId": deviceId, "path": path})


@mcp.tool(name="send_local_file", description="Send a file from your computer to the phone. Returns a one-time secure upload URL (valid for 10 minutes, max 100 MB).")
async def send_local_file(deviceId: str, name: str, folder: str = "Download") -> Any:
    return await call_backend("send_local_file", {"deviceId": deviceId, "name": name, "folder": folder})


@mcp.tool(name="send_file", description="Send a small file to the device with content passed inline as base64 (max 18 MB). Prefer send_local_file for disk files.")
async def send_file(deviceId: str, name: str, data_base64: str, folder: str = "Download") -> Any:
    return await call_backend("send_file", {"deviceId": deviceId, "name": name, "data_base64": data_base64, "folder": folder})


@mcp.tool(name="send_url", description="Download a file from a public http(s) URL and save it directly to the phone (max 100 MB).")
async def send_url(deviceId: str, url: str, name: str = "", folder: str = "Download") -> Any:
    return await call_backend("send_url", {"deviceId": deviceId, "url": url, "name": name, "folder": folder})


if __name__ == "__main__":
    port = int(os.environ.get("MCP_PORT", 8001))
    print(f"🚀 Starting Phone Remote FastMCP Server on port {port}...")
    mcp.run(transport="sse", port=port, host="0.0.0.0")
