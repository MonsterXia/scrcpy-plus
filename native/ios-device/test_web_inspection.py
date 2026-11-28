import asyncio
import json
import plistlib
import unittest
from unittest.mock import AsyncMock, patch

from pymobiledevice3.exceptions import WebInspectorNotEnabledError
from pymobiledevice3.services.webinspector import (
    Application, ApplicationPage, AutomationAvailability, Page, WirTypes,
)

from web_inspection import BoundedWebInspector, MAX_DOM_CHARS, MAX_FRAME_BYTES, inspect_web


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
        self.inspector = BoundedWebInspector(object())
        self.enterContext(patch("web_inspection.BoundedWebInspector", return_value=self.inspector))
        self.connection = AsyncMock()
        self.inspector._service = self.connection
        self.inspector.connect = AsyncMock(side_effect=self.connect)
        self.inspector.inspector_session = AsyncMock()
        self.rows = []

    async def connect(self):
        self.inspector._recv_task = asyncio.create_task(asyncio.Event().wait())

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
        markup = "<html>" + "⚡" * (MAX_DOM_CHARS * 4) + "</html>"
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
        self.connection.close.assert_awaited_once()

    async def test_oversized_dom_header_aborts_pending_read_before_allocating_payload(self):
        outer_html_requested = asyncio.Event()

        async def receive(size):
            self.assertEqual(size, 4)
            await outer_html_requested.wait()
            return (MAX_FRAME_BYTES + 1).to_bytes(4, "big")

        async def connect():
            self.inspector._recv_task = asyncio.create_task(self.inspector._receiving_task())

        async def send_command(method, **kwargs):
            if method == "DOM.getDocument":
                return reply({"root": {"nodeId": 7}})
            self.assertEqual(method, "DOM.getOuterHTML")
            outer_html_requested.set()
            await asyncio.Future()

        self.connection.recvall.side_effect = receive
        self.inspector.connect.side_effect = connect
        self.inspector.get_open_application_pages = AsyncMock(return_value=[target(101)])
        session = self.inspector.inspector_session.return_value
        session._receive_task = asyncio.create_task(asyncio.Event().wait())
        session.send_command = AsyncMock(side_effect=send_command)

        with self.assertRaisesRegex(ValueError, "result-limit"):
            await asyncio.wait_for(self.read({"op": "webDom", "targetId": "PID:101:1"}), timeout=2)
        self.connection.recvall.assert_awaited_once_with(4)
        self.connection.close.assert_awaited_once()
        self.assertTrue(session._receive_task.cancelled())
        self.assertEqual(self.rows, [])

    async def test_cumulative_budget_counts_multiple_raw_plist_headers_and_payloads(self):
        message = {"__selector": "_rpc_reportCurrentState:", "__argument": {}}
        payload = plistlib.dumps(message, fmt=plistlib.FMT_BINARY)
        header = len(payload).to_bytes(4, "big")
        self.inspector.remaining_bytes = 2 * (len(header) + len(payload))
        self.connection.recvall.side_effect = [header, payload, header, payload, header]

        for _ in range(2):
            self.assertEqual(await self.inspector._recv_message(), message)
        self.assertEqual(self.inspector.remaining_bytes, 0)
        with self.assertRaisesRegex(ConnectionError, "result-limit"):
            await self.inspector._recv_message()
        self.assertEqual([call.args[0] for call in self.connection.recvall.await_args_list],
                         [4, len(payload), 4, len(payload), 4])

    async def test_rejects_stale_or_attached_target_without_falling_back(self):
        self.inspector.get_open_application_pages = AsyncMock(return_value=[target(101, busy=True)])
        for target_id, error in [("1", "web-stale"), ("PID:102:1", "web-stale"), ("PID:101:1", "web-busy")]:
            with self.subTest(target_id=target_id), self.assertRaisesRegex(ValueError, error):
                await self.read({"op": "webDom", "targetId": target_id})
        self.inspector.inspector_session.assert_not_called()
        self.assertEqual(self.rows, [])

    async def test_disabled_service_is_reported_to_the_renderer(self):
        self.inspector.connect.side_effect = WebInspectorNotEnabledError()
        with self.assertRaisesRegex(ValueError, "web-unavailable"):
            await self.read({"op": "webPages"})
        self.connection.close.assert_awaited_once()
