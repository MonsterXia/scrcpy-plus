"""USB iOS workspace operations. Each helper process serves one NDJSON request."""
import asyncio
import errno
import hashlib
import json
import logging
import os
import posixpath
import re
import signal
import sys
import threading
import uuid
from contextlib import asynccontextmanager, contextmanager, redirect_stdout
from pathlib import Path

LIMIT = 4096
BUNDLE = re.compile(r'[A-Za-z0-9][A-Za-z0-9.-]{0,254}')
FIELDS = {
    'apps': (), 'processes': (), 'logs': (), 'webPages': (),
    'cleanupStaging': (), 'install': ('path',), 'uninstall': ('bundleId',), 'launch': ('bundleId',),
    'terminate': ('pid', 'bundleId'), 'webDom': ('targetId',), 'files': ('path',),
}
APP_FIELDS = ['ApplicationType', 'CFBundleIdentifier', 'CFBundleDisplayName', 'CFBundleName',
              'CFBundleShortVersionString', 'CFBundleVersion', 'UIFileSharingEnabled']
ERRORS = {'protocol', 'app-unavailable', 'process-changed', 'file-access', 'result-limit',
          'install-failed', 'uninstall-failed', 'launch-failed', 'developer-services', 'developer-usb-version', 'busy',
          'web-unavailable', 'web-busy', 'web-stale', 'web-timeout'}


def valid_text(value, limit):
    return isinstance(value, str) and 0 < len(value) <= limit and not re.search(r'[\x00-\x1f\x7f]', value)


def valid_name(value):
    return valid_text(value, 255) and value not in ('.', '..') and '/' not in value and '\\' not in value


def validate_request(request):
    if not isinstance(request, dict):
        raise ValueError('protocol')
    op = request.get('op')
    if not isinstance(op, str) or op not in FIELDS:
        raise ValueError('protocol')
    fields = set(FIELDS[op])
    if op == 'files' and 'bundleId' in request:
        fields.add('bundleId')
    if set(request) != {'op', 'udid'} | fields:
        raise ValueError('protocol')
    if not isinstance(request['udid'], str) or not re.fullmatch(r'[a-fA-F0-9-]{8,64}', request['udid']):
        raise ValueError('protocol')
    if 'bundleId' in fields and not (isinstance(request['bundleId'], str) and BUNDLE.fullmatch(request['bundleId'])):
        raise ValueError('protocol')
    if op == 'terminate' and not (type(request['pid']) is int and 1 < request['pid'] <= 2**31 - 1):
        raise ValueError('protocol')
    if op == 'webDom' and not valid_text(request['targetId'], 256):
        raise ValueError('protocol')
    if op in ('files', 'install') and not valid_text(request['path'], 4096):
        raise ValueError('protocol')
    if op == 'files':
        path = request['path']
        if path != '/' and (not path.startswith('/') or not all(valid_name(part) for part in path[1:].split('/'))):
            raise ValueError('protocol')
    if op == 'install':
        path = Path(request['path'])
        if not path.is_absolute() or path.suffix.lower() != '.ipa' or not path.is_file():
            raise ValueError('install-failed')


def bounded(values):
    if len(values) > LIMIT:
        raise ValueError('result-limit')
    return values


async def installed_apps(proxy, bundle=None):
    query = {'ApplicationType': 'Any', 'ReturnAttributes': APP_FIELDS}
    if bundle is not None:
        query['BundleIDs'] = [bundle]
    apps = await proxy.lookup(query)
    if not isinstance(apps, dict):
        raise ValueError('app-unavailable')
    return bounded(apps)


def shares_documents(info):
    # Some built-in apps advertise UIFileSharingEnabled even though
    # House Arrest cannot resolve them for VendDocuments.
    return info.get('ApplicationType') == 'User' and info.get('UIFileSharingEnabled') is True


def app_row(bundle, info):
    def field(*keys):
        return next((info[k][:512] for k in keys if isinstance(info.get(k), str) and info[k]), '')
    return {'bundleId': bundle, 'name': field('CFBundleDisplayName', 'CFBundleName') or bundle,
            'version': field('CFBundleShortVersionString', 'CFBundleVersion'),
            'user': info.get('ApplicationType') == 'User',
            'fileSharing': shares_documents(info)}


STAGING_NAME = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.ipa')


def staging_directory(udid):
    root = Path(os.environ.get('SCRCPY_PLUS_IOS_STAGING_ROOT', ''))
    if not root.is_absolute():
        raise ValueError('protocol')
    return root / hashlib.sha256(udid.lower().encode('ascii')).hexdigest()


@contextmanager
def lock_staging(directory):
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    # Keep this inode even when no uploads remain. Unlinking a locked file
    # would let a second helper acquire a different lock on the same device.
    with (directory / '.lock').open('a+b') as lock:
        lock.seek(0)
        try:
            if sys.platform == 'win32':
                import msvcrt
                msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            if error.errno in (errno.EACCES, errno.EAGAIN):
                raise ValueError('busy') from error
            raise
        try:
            yield
        finally:
            if sys.platform == 'win32':
                msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
            # Closing the file releases flock on Unix; process exit releases both locks.


def record_upload(directory):
    marker = directory / f'{uuid.uuid4()}.ipa'
    with marker.open('xb') as stream:
        os.fsync(stream.fileno())
    if sys.platform != 'win32':
        fd = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    return marker


async def remove_upload(afc, marker):
    from pymobiledevice3.exceptions import AfcFileNotFoundError
    from pymobiledevice3.services.afc import AfcError
    from pymobiledevice3.services.installation_proxy import TEMP_REMOTE_BASEDIR
    try:
        removed = await afc.rm_single(f'{TEMP_REMOTE_BASEDIR}/{marker.name}')
        if removed is not True:
            raise OSError('Unconfirmed staging removal')
    except AfcFileNotFoundError as error:
        if error.status != AfcError.OBJECT_NOT_FOUND:
            raise
    marker.unlink()


async def cleanup_staging(lockdown, directory):
    from pymobiledevice3.exceptions import AfcException
    from pymobiledevice3.services.afc import AfcService
    with lock_staging(directory):
        markers = [entry for entry in directory.iterdir()
                   if STAGING_NAME.fullmatch(entry.name) and not entry.is_symlink() and entry.is_file()]
        if markers:
            async with AfcService(lockdown) as afc:
                last_error = None
                for marker in markers:
                    try:
                        await remove_upload(afc, marker)
                    except AfcException as error:
                        # A single busy or inaccessible path must not strand later uploads.
                        last_error = error
                if last_error is not None:
                    raise last_error


async def install_ipa(lockdown, proxy, path, directory):
    from pymobiledevice3.services.afc import AfcService
    from pymobiledevice3.services.installation_proxy import TEMP_REMOTE_BASEDIR
    with lock_staging(directory), path.open('rb') as source:
        async with AfcService(lockdown) as afc:
            await afc.makedirs(TEMP_REMOTE_BASEDIR)
            marker = record_upload(directory)
            remote = f'{TEMP_REMOTE_BASEDIR}/{marker.name}'
            try:
                handle = await afc.fopen(remote, 'w')
                try:
                    while chunk := source.read(1024 * 1024):
                        await afc.fwrite(handle, chunk)
                finally:
                    await afc.fclose(handle)
                await proxy.send_package('Install', {}, None, remote)
            finally:
                # Keep the durable marker on disconnect, cancellation or a lost reply.
                # Cleanup failures must not turn a confirmed installation into a retry.
                try:
                    await remove_upload(afc, marker)
                except Exception:
                    pass


class UnsupportedUsbDeveloperVersion(ValueError):
    pass


@asynccontextmanager
async def developer_provider(lockdown):
    # Instruments is available directly on older iOS. On newer devices bind
    # the tunnel to the already selected USB connection, including on Wi-Fi-paired hosts.
    parts = lockdown.product_version.split('.')
    major = int(parts[0])
    if major == 17 and (len(parts) == 1 or int(parts[1]) < 4):
        raise UnsupportedUsbDeveloperVersion('developer-usb-version')
    if major < 17:
        yield lockdown
        return
    from pymobiledevice3.remote.tunnel_service import CoreDeviceTunnelProxy
    from pymobiledevice3.remote.userspace_tunnel import TunnelProvider, UserspaceRsdTunnel

    async def provider():
        return TunnelProvider(await CoreDeviceTunnelProxy.create(lockdown))

    async with UserspaceRsdTunnel(provider_factory=provider) as rsd:
        yield rsd


async def process_rows(lockdown):
    from pymobiledevice3.exceptions import PyMobileDevice3Exception
    from pymobiledevice3.services.dvt.instruments.device_info import DeviceInfo
    from pymobiledevice3.services.dvt.instruments.dvt_provider import DvtProvider
    from pymobiledevice3.services.installation_proxy import InstallationProxyService
    from pymobiledevice3.services.os_trace import OsTraceService
    try:
        async with asyncio.timeout(10):
            async with developer_provider(lockdown) as provider, DvtProvider(provider) as dvt, DeviceInfo(dvt) as info:
                processes = bounded(await info.proclist())
            async with InstallationProxyService(lockdown) as proxy:
                apps = await installed_apps(proxy)
        users = {bid for bid, app in apps.items() if app.get('ApplicationType') == 'User'}
    except (PyMobileDevice3Exception, TimeoutError, OSError, UnsupportedUsbDeveloperVersion):
        # Without a developer service, os_trace still exposes PID/name. It
        # does not establish a process-to-bundle identity for termination.
        async with OsTraceService(lockdown) as trace:
            payload = (await trace.get_pid_list()).get('Payload')
            if not isinstance(payload, dict):
                raise RuntimeError('invalid process list')
            processes = [{'pid': int(pid), 'name': value.get('ProcessName')}
                         for pid, value in bounded(payload).items() if str(pid).isdecimal()]
        users = set()
    for item in processes:
        pid, name, bundle = item.get('pid'), item.get('name'), item.get('bundleIdentifier')
        if not isinstance(pid, int) or not isinstance(name, str):
            continue
        row = {'pid': pid, 'name': name[:512]}
        if pid > 1 and bundle in users:
            row['bundleId'] = bundle
        yield row


async def control_app(lockdown, request):
    from pymobiledevice3.remote.core_device.app_service import AppServiceService
    from pymobiledevice3.services.dvt.instruments.dvt_provider import DvtProvider
    from pymobiledevice3.services.dvt.instruments.process_control import ProcessControl
    bundle = request['bundleId']
    async with developer_provider(lockdown) as provider:
        if request['op'] == 'launch' and lockdown.product_version.split('.')[0] == '26':
            async with AppServiceService(provider) as service:
                await service.launch_application(bundle, kill_existing=False)
            return
        async with DvtProvider(provider) as dvt, ProcessControl(dvt) as service:
            if request['op'] == 'launch':
                await service.launch(bundle, kill_existing=False)
            else:
                pid = await service.process_identifier_for_bundle_identifier(bundle)
                if pid != request['pid']:
                    raise ValueError('process-changed')
                await service.kill(pid)


async def log_rows(lockdown):
    from pymobiledevice3.services.os_trace import (
        OS_TRACE_RELAY_MESSAGE_FILTER_ALL, OsActivityStreamFlag as Flags, OsTraceService,
    )
    async with OsTraceService(lockdown) as service:
        async for line in service.syslog(message_filter=OS_TRACE_RELAY_MESSAGE_FILTER_ALL,
                                         stream_flags=int(Flags.PAYLOAD | Flags.DEBUG | Flags.INFO)):
            yield {'timestamp': line.timestamp.astimezone().isoformat(timespec='milliseconds'),
                   'process': posixpath.basename(line.filename)[:512], 'pid': line.pid,
                   'level': line.level.name or str(int(line.level)), 'message': line.message[:4096]}


async def directory_rows(afc, root, path):
    from pymobiledevice3.exceptions import AfcFileNotFoundError
    directory = root
    # AFC GET_FILE_INFO reports a symlink itself. Check every component before READ_DIR.
    for part in path.split('/'):
        if not part:
            continue
        directory = posixpath.join(directory, part)
        if (await afc.stat(directory)).get('st_ifmt') != 'S_IFDIR':
            raise ValueError('file-access')
    for name in bounded(await afc.listdir(directory)):
        if not valid_name(name):
            continue
        try:
            info = await afc.stat(posixpath.join(directory, name))
        except AfcFileNotFoundError:
            continue  # A file can disappear between READ_DIR and GET_FILE_INFO.
        kind = info.get('st_ifmt')
        if kind == 'S_IFREG':
            yield {'name': name, 'isDirectory': False, 'size': info['st_size']}
        elif kind == 'S_IFDIR':
            yield {'name': name, 'isDirectory': True}


async def list_files(lockdown, request, emit_row):
    from pymobiledevice3.exceptions import PyMobileDevice3Exception
    from pymobiledevice3.services.afc import AfcService
    from pymobiledevice3.services.house_arrest import DOCUMENTS_ROOT, HouseArrestService
    from pymobiledevice3.services.installation_proxy import InstallationProxyService
    bundle = request.get('bundleId')
    root = '/'
    if bundle:
        async with InstallationProxyService(lockdown) as proxy:
            app = (await installed_apps(proxy, bundle)).get(bundle, {})
            if not shares_documents(app):
                raise ValueError('file-access')
        root = DOCUMENTS_ROOT
        try:
            service = await HouseArrestService.create(lockdown, bundle, documents_only=True)
        except PyMobileDevice3Exception as error:
            if type(error) is not PyMobileDevice3Exception:
                raise
            raise ValueError('file-access') from error
    else:
        service = AfcService(lockdown)
    async with service:
        async for row in directory_rows(service, root, request['path']):
            emit_row(row)


async def operate(request, emit_row):
    from pymobiledevice3.lockdown import create_using_usbmux
    from pymobiledevice3.services.installation_proxy import InstallationProxyService
    op = request['op']
    async with await create_using_usbmux(serial=request['udid'], connection_type='USB', autopair=False) as lockdown:
        if op == 'cleanupStaging':
            await cleanup_staging(lockdown, staging_directory(request['udid']))
        elif op in ('webPages', 'webDom'):
            from web_inspection import inspect_web
            await inspect_web(lockdown, request, emit_row)
        elif op == 'files':
            await list_files(lockdown, request, emit_row)
        elif op in ('logs', 'processes'):
            rows = log_rows(lockdown) if op == 'logs' else process_rows(lockdown)
            async for row in rows:
                emit_row(row)
        else:
            bundle = request.get('bundleId')
            async with InstallationProxyService(lockdown) as proxy:
                if op == 'install':
                    await install_ipa(lockdown, proxy, Path(request['path']), staging_directory(request['udid']))
                    return
                apps = await installed_apps(proxy, bundle)
                if op == 'apps':
                    for bid, app in apps.items():
                        if BUNDLE.fullmatch(bid):
                            emit_row(app_row(bid, app))
                    return
                app = apps.get(bundle)
                if not app or (op in ('terminate', 'uninstall') and app.get('ApplicationType') != 'User'):
                    raise ValueError('app-unavailable')
                if op == 'uninstall':
                    await proxy.uninstall(bundle)
                    return
            await control_app(lockdown, request)


def error_code(error, op):
    from pymobiledevice3 import exceptions as e
    if isinstance(error, ValueError) and str(error) in ERRORS:
        return str(error)
    if isinstance(error, (e.PasswordRequiredError, e.DeviceHasPasscodeSetError)):
        return 'device-locked'
    if isinstance(error, (e.NotTrustedError, e.NotPairedError, e.PairingError)):
        return 'trust-computer'
    if isinstance(error, (e.DeviceNotFoundError, e.ConnectionFailedError, e.NoDeviceConnectedError,
                          e.ConnectionTerminatedError, ConnectionError, e.NotConnectedError)):
        return 'disconnected'
    if isinstance(error, TimeoutError):
        return 'timeout'
    if op in ('launch', 'terminate') and isinstance(error, (e.InvalidServiceError, e.DeveloperModeError,
                                                              e.DeveloperModeIsNotEnabledError, e.NotMountedError)):
        return 'developer-services'
    if isinstance(error, (e.AppInstallError, OSError)) and op in ('install', 'uninstall'):
        return op + '-failed'
    if op == 'files' and isinstance(error, (e.AfcException, e.AppNotInstalledError)):
        return 'file-access'
    if op == 'launch':
        return 'launch-failed'
    return 'device-error'


def cancel_on_parent_close(loop, task, fd):
    # A blocking OS read also works on Windows anonymous pipes. The request is
    # the only line the parent writes. EOF means it cancelled or exited.
    try:
        os.read(fd, 1)
    except OSError:
        pass
    try:
        loop.call_soon_threadsafe(task.cancel)
    except RuntimeError:
        pass  # The operation already finished and the loop closed.


async def run(request, emit_row, cancel_fd=None):
    loop = asyncio.get_running_loop()
    if cancel_fd is not None:
        threading.Thread(target=cancel_on_parent_close, args=(loop, asyncio.current_task(), cancel_fd),
                         daemon=True).start()
    if sys.platform != 'win32':
        loop.add_signal_handler(signal.SIGTERM, asyncio.current_task().cancel)
    timeout = {'logs': None, 'install': 600, 'files': 120, 'webPages': 40, 'webDom': 40}.get(request['op'], 45)
    async with asyncio.timeout(timeout):
        await operate(request, emit_row)


def main(cancel_on_eof=False):
    logging.disable(logging.CRITICAL)
    out = sys.stdout

    def emit(event):
        print(json.dumps(event, separators=(',', ':')), file=out, flush=True)

    op = None
    try:
        raw = sys.stdin.buffer.readline(65537)
        if len(raw) > 65536:
            raise ValueError('protocol')
        try:
            request = json.loads(raw)
        except (ValueError, UnicodeError, RecursionError) as error:
            raise ValueError('protocol') from error
        validate_request(request)
        op = request['op']
        with redirect_stdout(sys.stderr):
            asyncio.run(run(request, lambda row: emit({'row': row}), sys.stdin.fileno() if cancel_on_eof else None))
        emit({'done': True})
    except asyncio.CancelledError:
        sys.exit(1)
    except Exception as error:
        emit({'error': error_code(error, op)})
        sys.exit(1)
