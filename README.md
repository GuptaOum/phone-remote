# Phone Remote: Claude Dispatch for Android

Just like Claude Computer Use / Dispatch allows an LLM to control a laptop, this project is **Claude Dispatch for your phone**. It enables large language models to remote-control an Android device using the Model Context Protocol (MCP).

I built this project primarily to explore and learn how MCP servers work under the hood, and to bridge the gap between AI agents and mobile interfaces.

## Features
- **LLM-Driven Control:** Allows an LLM to tap, swipe, type, and navigate around an Android phone.
- **Screen & Camera Access:** Streams screen and camera data back to the LLM (or a browser) to close the perception-action loop.
- **File & System Management:** View and manage device files, track location, and execute system commands.
- **MCP Integration:** Exposes all phone capabilities as a set of standardized tools via an MCP server, so any compatible AI client (like Claude Desktop) can connect and start controlling the phone.

## How it works
The project consists of a Node.js signaling server and an Android companion app (built in Flutter & Kotlin). The Node.js server acts as an MCP server, exposing tools like `take_screenshot`, `tap`, `swipe`, `list_files`, and `type_text`. 

When an AI agent (like Claude) calls these tools, the server relays the commands over WebSockets to the Android app, which executes them using Android's native Accessibility Services and MediaProjection APIs.
