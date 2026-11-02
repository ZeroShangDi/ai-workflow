"""Capability bundle loader and bounded host RPC for Voice Center."""

import asyncio
import importlib
import json
import os
import re
import uuid
from functools import lru_cache
from pathlib import Path

import httpx
from pipecat.adapters.schemas.function_schema import FunctionSchema

CAPABILITY_ROOT = Path(__file__).resolve().parent / "capabilities"


@lru_cache(maxsize=20)
def load_package(name):
    if not isinstance(name, str) or not re.fullmatch(r"[a-z][a-z0-9_]{0,39}", name):
        raise ValueError("Invalid voice capability")
    module = importlib.import_module(f".capabilities.{name}", __package__)
    root = CAPABILITY_ROOT / name
    manifest = json.loads((root / "plugin.json").read_text())
    if manifest.get("id") != name or manifest.get("schemaVersion") != 1:
        raise ValueError(f"Invalid capability manifest: {name}")
    return module, manifest, (root / "SKILL.md").read_text()


def active_capabilities():
    always = ["voice_history", "web_search"]
    mode = os.environ.get("VOICE_CENTER_WORK_MODE", "control").strip().lower()
    if mode == "market":
        return [*always, "work_market"]
    if mode == "control":
        return [*always, "work_control"]
    if mode in {"none", "disabled", ""}:
        return always
    raise ValueError(f"Unsupported VOICE_CENTER_WORK_MODE: {mode}")


def load_packages():
    return [load_package(name) for name in active_capabilities()]


class HostBridge:
    def __init__(self, connection):
        self.connection = connection
        self.pending = {}
        self.closed = False

    def emit(self, event):
        if self.closed:
            raise RuntimeError("Voice host is closed")
        if not isinstance(event, dict) or event.get("type") not in {"task_proposal"} or len(json.dumps(event, ensure_ascii=False)) > 16000:
            raise ValueError("Unsupported host event")
        self.connection.send_app_message(event)

    async def request(self, method, path, body, request_id):
        if self.closed:
            raise RuntimeError("Voice host is closed")
        key = str(uuid.uuid4())
        future = asyncio.get_running_loop().create_future()
        self.pending[key] = future
        try:
            self.connection.send_app_message({
                "type": "plugin_host_request",
                "id": key,
                "method": method,
                "path": path,
                "body": body,
                "requestId": request_id,
            })
            return await asyncio.wait_for(future, 20)
        finally:
            self.pending.pop(key, None)

    def receive(self, value):
        if not isinstance(value, dict) or value.get("type") != "plugin_host_result":
            return
        if not isinstance(value.get("id"), str):
            return
        future = self.pending.get(value.get("id"))
        if future is not None and not future.done():
            if value.get("error"):
                future.set_exception(RuntimeError("Host request was not confirmed"))
            else:
                future.set_result(value.get("data"))

    def close(self):
        self.closed = True
        for future in self.pending.values():
            if not future.done():
                future.set_exception(RuntimeError("Voice host is closed"))
        self.pending.clear()


class PluginHost:
    def __init__(self, connection, identity, context):
        self.bridge = HostBridge(connection)
        self.plugins = []
        self.specs = []
        self.timeouts = {}
        self.instructions = []
        for module, manifest, instructions in load_packages():
            plugin = module.activate(identity=identity, context=context, host=self.bridge)
            if not plugin.enabled:
                continue
            self.plugins.append(plugin)
            self.instructions.append(instructions)
            for spec in manifest["tools"]:
                if spec.get("requiresHost") and not identity.get("host_plugin_bridge"):
                    continue
                if any(s.name == spec["name"] for s, _ in self.specs):
                    raise ValueError(f"Duplicate voice tool: {spec['name']}")
                timeout = spec.get("timeoutSeconds", 60)
                if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not 1 <= timeout <= 180:
                    raise ValueError("Invalid capability timeout")
                self.timeouts[spec["name"]] = timeout
                self.specs.append((
                    FunctionSchema(
                        name=spec["name"],
                        description=spec["description"],
                        properties=spec["properties"],
                        required=spec["required"],
                    ),
                    plugin,
                ))

    def register(self, llm):
        for spec, plugin in self.specs:
            async def invoke(params, plugin=plugin, name=spec.name):
                try:
                    result = await plugin.execute(name, params.arguments)
                except (ValueError, RuntimeError, TimeoutError, httpx.HTTPError):
                    result = {"error": "Operation was not confirmed; check state before retrying."}
                await params.result_callback(result)
            llm.register_function(spec.name, invoke, cancel_on_interruption=False, timeout_secs=self.timeouts[spec.name])

    def record_transcript(self, role, text, identity):
        for plugin in self.plugins:
            callback = getattr(plugin, "record_transcript", None)
            if callback:
                callback(role, text, identity)

    async def prepare_notice(self, notice):
        for plugin in self.plugins:
            callback = getattr(plugin, "prepare_notice", None)
            if callback:
                result = await callback(notice)
                if result is not None:
                    return result
        return notice["text"]

    def close(self):
        self.bridge.close()
        for plugin in self.plugins:
            callback = getattr(plugin, "close", None)
            if callback:
                callback()

    def notice_delivered(self, notice_id):
        for plugin in self.plugins:
            callback = getattr(plugin, "notice_delivered", None)
            if callback:
                callback(notice_id)


def activate(**kwargs):
    raise RuntimeError("Capability packages are loaded by PluginHost")
