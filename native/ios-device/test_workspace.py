import asyncio
import json
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import workspace
from pymobiledevice3.exceptions import AfcFileNotFoundError, AppInstallError, InvalidServiceError, PasswordRequiredError
from pymobiledevice3.services.afc import AfcError

SERIAL = '01234567'
BUNDLE = 'com.example.Reader'
PROXY = 'pymobiledevice3.services.installation_proxy.InstallationProxyService'
AFC = 'pymobiledevice3.services.afc.AfcService'
DVT = 'pymobiledevice3.services.dvt.instruments.dvt_provider.DvtProvider'
CONTROL = 'pymobiledevice3.services.dvt.instruments.process_control.ProcessControl'
CONNECTION = 'pymobiledevice3.lockdown.create_using_usbmux'


class ProtocolTests(unittest.TestCase):
    def test_workspace_mode_cannot_run_commands_or_select_other_transports(self):
        for fields in [
            {'op': 'shell'}, {'op': 'apps', 'port': 1234},
            {'op': 'logs', 'udid': 'all'}, {'op': 'terminate', 'pid': True, 'bundleId': BUNDLE},
            {'op': 'files', 'path': 'Documents'}, {'op': 'files', 'path': '/one/../two'},
            {'op': 'files', 'path': '/one//two'}, {'op': 'files', 'path': '/one\\two'},
            {'op': 'files', 'path': '/one\x00two'}, {'op': 'webDom', 'targetId': '\n'},
        ]:
            with self.subTest(fields=fields), self.assertRaisesRegex(ValueError, 'protocol'):
                workspace.validate_request({'udid': SERIAL, **fields})

    def test_private_stdio_emits_single_failure_and_rejects_non_ipa(self):
        script = Path(workspace.__file__).with_name('device.py')
        for request, code in [('{}','protocol'), ('{' + 'x'*65536, 'protocol'),
                              (json.dumps({'op':'install','udid':SERIAL,'path':str(script)}),'install-failed')]:
            child = subprocess.run([sys.executable, str(script), '--workspace'], input=request,
                                   capture_output=True, text=True, timeout=6)
            self.assertNotEqual(child.returncode, 0)
            self.assertEqual(json.loads(child.stdout), {'error': code})

    def test_apps_report_explicit_system_and_file_sharing_metadata(self):
        row = workspace.app_row(BUNDLE, {'CFBundleName': 'Reader', 'ApplicationType': 'User',
                                        'CFBundleVersion': '4', 'UIFileSharingEnabled': True})
        self.assertEqual(row, {'name': 'Reader', 'version': '4', 'bundleId': BUNDLE,
                               'user': True, 'fileSharing': True})
        row = workspace.app_row(BUNDLE, {'ApplicationType': 'System', 'UIFileSharingEnabled': True})
        self.assertFalse(row['user'])
        self.assertFalse(row['fileSharing'])


class DeviceWorkspaceTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.lockdown = AsyncMock()
        self.lockdown.__aenter__.return_value = self.lockdown
        self.lockdown.product_version = '16.7'
        self.connect = self.stack.enter_context(patch(CONNECTION, new=AsyncMock(return_value=self.lockdown)))
        proxy_factory = self.stack.enter_context(patch(PROXY))
        self.proxy = proxy_factory.return_value.__aenter__.return_value
        self.proxy.lookup.return_value = {BUNDLE: {'ApplicationType': 'User'}}
        self.rows = []
        journal = self.stack.enter_context(tempfile.TemporaryDirectory())
        self.stack.enter_context(patch.dict(os.environ, {'SCRCPY_PLUS_IOS_STAGING_ROOT': journal}))

    async def run_op(self, op, **values):
        request = {'op': op, 'udid': SERIAL, **values}
        workspace.validate_request(request)
        await workspace.operate(request, self.rows.append)
        self.connect.assert_awaited_with(serial=SERIAL, connection_type='USB', autopair=False)

    async def test_uninstall_rechecks_user_classification_for_exact_bundle(self):
        for app in [{}, {BUNDLE: {'ApplicationType': 'System'}}, {'other': {'ApplicationType': 'User'}}]:
            self.proxy.lookup.return_value = app
            with self.assertRaisesRegex(ValueError, 'app-unavailable'):
                await self.run_op('uninstall', bundleId=BUNDLE)
        self.proxy.uninstall.assert_not_awaited()
        self.proxy.lookup.return_value = {BUNDLE: {'ApplicationType': 'User'}}
        await self.run_op('uninstall', bundleId=BUNDLE)
        self.assertEqual(self.proxy.lookup.await_args.args[0]['BundleIDs'], [BUNDLE])
        self.proxy.uninstall.assert_awaited_once_with(BUNDLE)

    async def test_launch_preserves_running_app_and_termination_rechecks_live_pid(self):
        self.stack.enter_context(patch(DVT))
        control = self.stack.enter_context(patch(CONTROL)).return_value.__aenter__.return_value
        await self.run_op('launch', bundleId=BUNDLE)
        control.launch.assert_awaited_once_with(BUNDLE, kill_existing=False)
        control.process_identifier_for_bundle_identifier.return_value = 88
        with self.assertRaisesRegex(ValueError, 'process-changed'):
            await self.run_op('terminate', bundleId=BUNDLE, pid=77)
        control.kill.assert_not_awaited()
        await self.run_op('terminate', bundleId=BUNDLE, pid=88)
        control.kill.assert_awaited_once_with(88)
        self.proxy.lookup.return_value = {BUNDLE: {'ApplicationType': 'System'}}
        with self.assertRaisesRegex(ValueError, 'app-unavailable'):
            await self.run_op('terminate', bundleId=BUNDLE, pid=88)
        self.assertEqual(control.kill.await_count, 1)

    async def test_partial_ipa_install_removes_only_its_own_staging_file(self):
        afc = self.stack.enter_context(patch(AFC)).return_value.__aenter__.return_value
        afc.fopen.return_value = 42
        afc.rm_single.return_value = True
        self.proxy.send_package.side_effect = AppInstallError('device denied')
        with tempfile.TemporaryDirectory() as temp:
            ipa = Path(temp) / 'sample.ipa'
            ipa.write_bytes(b'x' * (1024 * 1024 + 3))
            with self.assertRaises(AppInstallError):
                await self.run_op('install', path=str(ipa))
        remote = afc.fopen.await_args.args[0]
        self.assertRegex(remote, r'^/PublicStaging/pymobiledevice3/[0-9a-f-]+\.ipa$')
        self.assertEqual([len(call.args[1]) for call in afc.fwrite.await_args_list], [1024 * 1024, 3])
        afc.fclose.assert_awaited_once_with(42)
        self.proxy.send_package.assert_awaited_once_with('Install', {}, None, remote)
        afc.rm_single.assert_awaited_once_with(remote)
        self.assertFalse(list(workspace.staging_directory(SERIAL).glob('*.ipa')))

    async def test_closing_parent_pipe_cancels_upload_and_releases_staging_file(self):
        afc = self.stack.enter_context(patch(AFC)).return_value.__aenter__.return_value
        afc.fopen.return_value = 42
        afc.rm_single.return_value = True
        uploading = asyncio.Event()

        async def write(*args):
            uploading.set()
            await asyncio.Event().wait()

        afc.fwrite.side_effect = write
        with tempfile.TemporaryDirectory() as temp:
            ipa = Path(temp) / 'test.ipa'
            ipa.write_bytes(b'data')
            read_fd, write_fd = os.pipe()
            with os.fdopen(read_fd, 'rb') as control:
                with os.fdopen(write_fd, 'wb'):
                    request = {'op': 'install', 'udid': SERIAL, 'path': str(ipa)}
                    task = asyncio.create_task(workspace.run(request, self.rows.append, control.fileno()))
                    await asyncio.wait_for(uploading.wait(), 3)
                with self.assertRaises(asyncio.CancelledError):
                    await asyncio.wait_for(task, 3)
        afc.fclose.assert_awaited_once_with(42)
        self.proxy.send_package.assert_not_awaited()
        afc.rm_single.assert_awaited_once_with(afc.fopen.await_args.args[0])
        self.assertFalse(list(workspace.staging_directory(SERIAL).glob('*.ipa')))

    async def test_unplug_recovery_is_scoped_and_lost_deletion_reply_is_retryable(self):
        afc = self.stack.enter_context(patch(AFC)).return_value.__aenter__.return_value
        afc.fwrite.side_effect = ConnectionResetError()
        afc.rm_single.side_effect = ConnectionResetError()
        with tempfile.TemporaryDirectory() as temp:
            ipa = Path(temp) / 'incoming.ipa'
            ipa.write_bytes(b'partial')
            with self.assertRaises(ConnectionResetError):
                await self.run_op('install', path=str(ipa))
        remote = afc.fopen.await_args.args[0]
        directory = workspace.staging_directory(SERIAL)
        marker, = directory.glob('*.ipa')
        self.assertEqual(marker.name, Path(remote).name)
        self.proxy.send_package.assert_not_awaited()
        (directory / 'manually-placed.ipa').touch()
        # Another phone reattaches before this one.
        afc.rm_single.reset_mock()
        await workspace.operate({'op': 'cleanupStaging', 'udid': '98765432'}, self.rows.append)
        afc.rm_single.assert_not_awaited()
        # The first recovery deletes the file but loses the AFC success response.
        with self.assertRaises(ConnectionResetError):
            await self.run_op('cleanupStaging')
        self.assertTrue(marker.exists())
        afc.rm_single.side_effect = AfcFileNotFoundError('not found', AfcError.OBJECT_NOT_FOUND)
        await self.run_op('cleanupStaging')
        await self.run_op('cleanupStaging')
        self.assertEqual([call.args for call in afc.rm_single.await_args_list], [(remote,), (remote,)])
        self.assertFalse(marker.exists())
        self.assertTrue((directory / 'manually-placed.ipa').exists())
        self.proxy.send_package.assert_not_awaited()

    async def test_recovery_does_not_clear_marker_on_ambiguous_afc_response(self):
        afc = self.stack.enter_context(patch(AFC)).return_value.__aenter__.return_value
        directory = workspace.staging_directory(SERIAL)
        with workspace.lock_staging(directory):
            marker = workspace.record_upload(directory)
        afc.rm_single.side_effect = AfcFileNotFoundError('read error', AfcError.READ_ERROR)
        with self.assertRaises(AfcFileNotFoundError):
            await self.run_op('cleanupStaging')
        self.assertTrue(marker.exists())
        afc.rm_single.side_effect = None
        afc.rm_single.return_value = False
        with self.assertRaises(OSError):
            await self.run_op('cleanupStaging')
        self.assertTrue(marker.exists())
        afc.rm_single.return_value = True
        await self.run_op('cleanupStaging')
        self.assertFalse(marker.exists())

    async def test_helper_crash_releases_lock_and_retains_durable_marker(self):
        directory = workspace.staging_directory(SERIAL)
        script = ("from workspace import lock_staging, record_upload; from pathlib import Path; import sys, os\n"
                  "with lock_staging(directory := Path(sys.argv[1])):\n record_upload(directory)\n os._exit(71)")
        child = await asyncio.create_subprocess_exec(sys.executable, '-c', script, str(directory),
                                                     cwd=Path(workspace.__file__).parent)
        self.assertEqual(await asyncio.wait_for(child.wait(), 5), 71)
        marker, = directory.glob('*.ipa')
        afc = self.stack.enter_context(patch(AFC)).return_value.__aenter__.return_value
        afc.rm_single.return_value = True
        await self.run_op('cleanupStaging')
        afc.rm_single.assert_awaited_once_with('/PublicStaging/pymobiledevice3/' + marker.name)
        self.assertFalse(marker.exists())

    async def test_active_upload_owns_lock_across_processes_until_cleanup(self):
        afc = self.stack.enter_context(patch(AFC)).return_value.__aenter__.return_value
        uploading = asyncio.Event()
        finish = asyncio.Event()
        directory = workspace.staging_directory(SERIAL)

        async def write(*args):
            self.assertEqual(len(list(directory.glob('*.ipa'))), 1)
            uploading.set()
            await finish.wait()

        async def child_lock():
            script = ("from workspace import lock_staging; from pathlib import Path; import sys\n"
                      "try:\n with lock_staging(Path(sys.argv[1])): print('acquired')\n"
                      "except ValueError as error: print(str(error))")
            child = await asyncio.create_subprocess_exec(
                sys.executable, '-c', script, str(directory), cwd=Path(workspace.__file__).parent,
                stdout=asyncio.subprocess.PIPE)
            stdout, _ = await asyncio.wait_for(child.communicate(), 5)
            self.assertEqual(child.returncode, 0)
            return stdout.strip()

        afc.fwrite.side_effect = write
        afc.rm_single.return_value = True
        with tempfile.TemporaryDirectory() as temp:
            ipa = Path(temp) / 'test.ipa'
            ipa.write_bytes(b'data')
            install = asyncio.create_task(self.run_op('install', path=str(ipa)))
            try:
                await asyncio.wait_for(uploading.wait(), 3)
                self.assertEqual(await child_lock(), b'busy')
                with self.assertRaisesRegex(ValueError, 'busy'):
                    await self.run_op('cleanupStaging')
                afc.rm_single.assert_not_awaited()
            finally:
                finish.set()
                await install
        self.assertEqual(await child_lock(), b'acquired')
        self.assertFalse(list(directory.glob('*.ipa')))

    async def test_ios_17_before_usb_proxy_explains_launch_and_keeps_readonly_pid_list(self):
        proxy = self.stack.enter_context(patch('pymobiledevice3.remote.tunnel_service.CoreDeviceTunnelProxy.create'))
        trace = self.stack.enter_context(patch('pymobiledevice3.services.os_trace.OsTraceService'))
        trace.return_value.__aenter__.return_value.get_pid_list.return_value = {'Payload': {'42': {'ProcessName': 'App'}}}
        for version in ('17', '17.0.1', '17.3.1'):
            self.lockdown.product_version = version
            with self.assertRaisesRegex(ValueError, 'developer-usb-version'):
                await self.run_op('launch', bundleId=BUNDLE)
        await self.run_op('processes')
        self.assertEqual(self.rows, [{'name': 'App', 'pid': 42}])
        proxy.assert_not_called()
        self.lockdown.product_version = '17.4.0'
        proxy.side_effect = InvalidServiceError('missing', SERIAL, '17.4.0')
        with self.assertRaises(InvalidServiceError):
            await self.run_op('launch', bundleId=BUNDLE)
        proxy.assert_awaited_once()

    async def test_process_rows_join_by_device_bundle_id_never_executable_name(self):
        self.stack.enter_context(patch(DVT))
        device = self.stack.enter_context(patch('pymobiledevice3.services.dvt.instruments.device_info.DeviceInfo'))
        device.return_value.__aenter__.return_value.proclist.return_value = [
            {'pid': 1, 'name': 'Reader', 'bundleIdentifier': BUNDLE},
            {'pid': 42, 'name': 'Reader', 'bundleIdentifier': BUNDLE},
            {'pid': 43, 'name': 'Reader', 'bundleIdentifier': 'system'},
            {'pid': 44, 'name': 'Reader'},
        ]
        await self.run_op('processes')
        self.assertEqual([row.get('bundleId') for row in self.rows], [None, BUNDLE, None, None])

    async def test_process_list_without_developer_services_has_no_termination_targets(self):
        factory = self.stack.enter_context(patch(DVT))
        factory.return_value.__aenter__.side_effect = InvalidServiceError('unavailable', SERIAL, '16.7')
        trace = self.stack.enter_context(patch('pymobiledevice3.services.os_trace.OsTraceService'))
        trace.return_value.__aenter__.return_value.get_pid_list.return_value = {
            'Payload': {'38': {'ProcessName': 'Reader'}}}
        await self.run_op('processes')
        self.assertEqual(self.rows, [{'pid': 38, 'name': 'Reader'}])

    async def test_house_arrest_only_vends_shared_documents_and_omits_links(self):
        house = self.stack.enter_context(patch('pymobiledevice3.services.house_arrest.HouseArrestService.create'))
        service = AsyncMock()
        house.return_value = service
        for app in [{'ApplicationType': 'System', 'UIFileSharingEnabled': True},
                    {'ApplicationType': 'User', 'UIFileSharingEnabled': False}]:
            self.proxy.lookup.return_value = {BUNDLE: app}
            with self.assertRaisesRegex(ValueError, 'file-access'):
                await self.run_op('files', path='/', bundleId=BUNDLE)
        house.assert_not_awaited()
        self.proxy.lookup.return_value = {BUNDLE: {'ApplicationType': 'User', 'UIFileSharingEnabled': True}}
        service.listdir.return_value = ['doc', 'photo.png', 'link', '../outside', '/etc']
        service.stat.side_effect = lambda p: {
            '/Documents/child': {'st_ifmt': 'S_IFDIR'},
            '/Documents/child/doc': {'st_ifmt': 'S_IFDIR'},
            '/Documents/child/photo.png': {'st_ifmt': 'S_IFREG', 'st_size': 3},
            '/Documents/child/link': {'st_ifmt': 'S_IFLNK'},
        }[p]
        await self.run_op('files', path='/child', bundleId=BUNDLE)
        house.assert_awaited_once_with(self.lockdown, BUNDLE, documents_only=True)
        service.listdir.assert_awaited_once_with('/Documents/child')
        self.assertEqual(self.rows, [{'name':'doc','isDirectory':True},
                                    {'name':'photo.png','isDirectory':False,'size':3}])

    async def test_media_directory_rejects_symlink_in_parent_chain(self):
        afc = AsyncMock()
        self.stack.enter_context(patch(AFC, return_value=afc))
        afc.stat.return_value = {'st_ifmt': 'S_IFLNK'}
        with self.assertRaisesRegex(ValueError, 'file-access'):
            await self.run_op('files', path='/bad/nested')
        afc.stat.assert_awaited_once_with('/bad')
        afc.listdir.assert_not_awaited()

    async def test_live_log_stream_maps_device_records_and_bounds_messages(self):
        from datetime import datetime
        from pymobiledevice3.services.os_trace import (
            OS_TRACE_RELAY_MESSAGE_FILTER_ALL, SyslogLogLevel, OsActivityStreamFlag,
        )
        timestamp = datetime.fromtimestamp(1).replace(microsecond=123000)

        async def entries(**kwargs):
            self.assertFalse(kwargs['stream_flags'] & OsActivityStreamFlag.HISTORICAL)
            self.assertEqual(kwargs['message_filter'], OS_TRACE_RELAY_MESSAGE_FILTER_ALL)
            for level in (SyslogLogLevel.NOTICE, SyslogLogLevel.ERROR, SyslogLogLevel.FAULT):
                yield SimpleNamespace(pid=41, message='a' * 8192, filename='/bin/demo', level=level,
                                      timestamp=timestamp)
        trace = self.stack.enter_context(patch('pymobiledevice3.services.os_trace.OsTraceService'))
        trace.return_value.__aenter__.return_value.syslog = entries
        await self.run_op('logs')
        self.assertEqual([row['level'] for row in self.rows], ['NOTICE', 'ERROR', 'FAULT'])
        self.assertEqual((self.rows[0]['pid'], self.rows[0]['process']), (41, 'demo'))
        self.assertEqual(len(self.rows[0]['message']), 4096)
        self.assertEqual(self.rows[0]['timestamp'], timestamp.isoformat(timespec='milliseconds'))

    async def test_locked_device_reports_unlock_for_every_service(self):
        for op in workspace.FIELDS:
            self.assertEqual(workspace.error_code(PasswordRequiredError(), op), 'device-locked')


if __name__ == '__main__':
    unittest.main()
