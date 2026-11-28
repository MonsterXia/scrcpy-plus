import asyncio
import json
import unittest
from unittest.mock import AsyncMock, patch

from pymobiledevice3.exceptions import WebInspectorNotEnabledError
from pymobiledevice3.services.webinspector import (
    Application, ApplicationPage, AutomationAvailability, Page, WirTypes,
)

from web_inspection import MAX_DOM_CHARS, inspect_web


def target(pid, kind=WirTypes.WEB_PAGE, busy=False):
    app = Application(f"PID:{pid}", f"test.app{pid}", pid, f"App {pid}",
                      AutomationAvailability.UNKNOWN, 1, False, True)
    page = Page(1, kind, "https://example.test/", f"Page {pid}", "other" if busy else "")
    return ApplicationPage(app, page)


def reply(result):
    return {"method": "Target.dispatchMessageFromTarget",
            "params": {"message": json.dumps({"id": 1, "result": result})}}


class InspectionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.service = self.enterContext(patch("web_inspection.WebinspectorService"))
        self.inspector = self.service.return_value.__aenter__.return_value
        self.rows = []

    async def read(self, request):
        await inspect_web(object(), request, self.rows.append)

    async def test_lists_per_app_pages_without_opening_a_session(self):
        self.inspector.get_open_application_pages = AsyncMock(return_value=[
            target(101), target(102, WirTypes.WEB), target(103, WirTypes.SERVICE_WORKER),
        ])
        await self.read({"op": "webPages"})
        self.assertEqual([r["targetId"] for r in self.rows], ["PID:101:1", "PID:102:1"])
        self.assertEqual(self.rows[0]["url"], "https://example.test/")
        self.inspector.inspector_session.assert_not_called()

    async def test_reads_only_the_selected_apps_live_document_with_a_bound(self):
        other, selected = target(101), target(102)
        self.inspector.get_open_application_pages = AsyncMock(return_value=[other, selected])
        self.inspector.inspector_session = AsyncMock()
        session = self.inspector.inspector_session.return_value
        session._receive_task = asyncio.create_task(asyncio.sleep(60))
        markup = "<html>" + "⚡" * MAX_DOM_CHARS + "</html>"
        session.send_command = AsyncMock(side_effect=[
            reply({"root": {"nodeId": 7}}), reply({"outerHTML": markup}),
        ])
        await self.read({"op": "webDom", "targetId": "PID:102:1"})
        self.inspector.inspector_session.assert_awaited_once_with(selected.application, selected.page)
        self.assertEqual(session.send_command.await_args_list[0].args, ("DOM.getDocument",))
        self.assertEqual(session.send_command.await_args_list[1].args, ("DOM.getOuterHTML",))
        self.assertEqual(session.send_command.await_args_list[1].kwargs, {"nodeId": 7})
        self.assertEqual(len(session.send_command.await_args_list), 2)
        self.assertEqual("".join(r["html"] for r in self.rows), markup[:MAX_DOM_CHARS])
        self.assertTrue(all(r["truncated"] and len(r["html"]) <= 1024 for r in self.rows))
        self.assertTrue(session._receive_task.cancelled())

    async def test_rejects_stale_or_attached_target_without_falling_back(self):
        self.inspector.get_open_application_pages = AsyncMock(return_value=[target(101, busy=True)])
        for target_id, error in [("1", "web-stale"), ("PID:102:1", "web-stale"), ("PID:101:1", "web-busy")]:
            with self.subTest(target_id=target_id), self.assertRaisesRegex(ValueError, error):
                await self.read({"op": "webDom", "targetId": target_id})
        self.inspector.inspector_session.assert_not_called()
        self.assertEqual(self.rows, [])

    async def test_disabled_service_is_reported_to_the_renderer(self):
        self.service.return_value.__aenter__.side_effect = WebInspectorNotEnabledError()
        with self.assertRaisesRegex(ValueError, "web-unavailable"):
            await self.read({"op": "webPages"})
