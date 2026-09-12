# Phone Remote: Claude Dispatch for Android

Just like Claude Computer Use / Dispatch allows an LLM to control a laptop, this project is **Claude Dispatch for your phone**. It enables large language models to remote-control an Android device using the Model Context Protocol (MCP).

I built this project primarily to explore and learn how MCP servers work under the hood, and to bridge the gap between AI agents and mobile interfaces.

## Features
- **LLM-Driven Control:** Allows an LLM to tap, swipe, type, and navigate around an Android phone using native Android accessibility hooks.
- **Screen & Camera Access:** Streams screen and camera data back to the LLM (or a browser) to close the perception-action loop.
- **Advanced File Management:** Fully integrated file system access. You can ask the LLM to list all files in your `Downloads` directory, and it will fetch the file details. You can even instruct the LLM to download or upload specific files directly through the LLM call itself!
- **MCP Integration:** Exposes all phone capabilities as a set of standardized tools via an MCP server, so any compatible AI client (like Claude Desktop) can connect and start controlling the phone.

## How it works

The project consists of a Node.js signaling server and an Android companion app (built in Flutter & Kotlin). The Node.js server acts as an MCP server, exposing tools like `take_screenshot`, `tap`, `swipe`, `list_files`, `download_file`, and `type_text`. 

When an AI agent (like Claude) calls these tools, the server relays the commands over WebSockets to the Android app. 

### Leveraging Native Android APIs
To make the LLM's commands a reality on the device, the Android app heavily utilizes native Android APIs:
- **`RemoteAccessibilityService`:** This is the core of the touch control system. By leveraging Android's Accessibility Services, the app can inject raw touch events (taps, long presses, scrolls, and swipes) and dispatch keyboard events to simulate user typing. This allows the LLM to navigate any app seamlessly without needing a rooted device.
- **`MediaProjection`:** Used to capture the device's screen and stream it back to the MCP server as JPEG frames, allowing the AI to "see" what is on the screen and decide its next action.
