"""Read existing Safari and WKWebView pages through the paired device's Web Inspector."""

import asyncio
import json
from contextlib import suppress

from pymobiledevice3.exceptions import WebInspectorNotEnabledError
from pymobiledevice3.services.webinspector import WebinspectorService, WirTypes, make_target_id

MAX_PAGES = 128
MAX_DOM_CHARS = 32_768
CHUNK_CHARS = 1024


async def _read_markup(inspector, app, page):
    session = await inspector.inspector_session(app, page)
    try:
        # A WebKit page session multiplexes replies inside Target.dispatchMessageFromTarget.
        document = await session.send_command("DOM.getDocument")
        root = json.loads(document["params"]["message"]).get("result", {}).get("root")
        if not root or not root.get("nodeId"):
            raise ValueError("web-stale")
        reply = await session.send_command("DOM.getOuterHTML", nodeId=root["nodeId"])
        markup = json.loads(reply["params"]["message"]).get("result", {}).get("outerHTML")
        if not isinstance(markup, str):
            raise ValueError("web-stale")
        return markup
    finally:
        # 11.57.1 exposes no close() for InspectorSession. End its polling task
        # before closing the owning WebinspectorService (which detaches the socket).
        session._receive_task.cancel()
        with suppress(asyncio.CancelledError):
            await session._receive_task


async def inspect_web(lockdown, request, emit_row):
    try:
        async with asyncio.timeout(32), WebinspectorService(lockdown) as inspector:
            pairs = await inspector.get_open_application_pages(timeout=1)
            if not inspector.is_connected:
                raise ConnectionError("device-disconnected")
            listed = 0
            for pair in pairs:
                app, page = pair.application, pair.page
                if page.type_ not in (WirTypes.WEB, WirTypes.WEB_PAGE, WirTypes.PAGE):
                    continue
                target_id = make_target_id(app.id_, str(page.id_))
                if request["op"] == "webPages":
                    emit_row({
                        "targetId": target_id, "app": (app.name or app.bundle)[:240],
                        "title": page.web_title[:240], "url": page.web_url[:1600],
                    })
                    listed += 1
                    if listed == MAX_PAGES:
                        break
                elif request["op"] == "webDom" and target_id == request["targetId"]:
                    if page.web_connection_id:
                        raise ValueError("web-busy")
                    markup = await _read_markup(inspector, app, page)
                    end = min(len(markup), MAX_DOM_CHARS)
                    for offset in range(0, max(end, 1), CHUNK_CHARS):
                        emit_row({
                            "html": markup[offset:min(offset + CHUNK_CHARS, end)],
                            "truncated": end < len(markup),
                        })
                    return
            if request["op"] == "webDom":
                raise ValueError("web-stale")
    except WebInspectorNotEnabledError as error:
        raise ValueError("web-unavailable") from error
    except TimeoutError as error:
        raise ValueError("web-timeout") from error
