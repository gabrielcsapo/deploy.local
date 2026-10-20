"""Tests loaded by node --test; never connect to a real session bus or desktop."""
import json
import os
from pathlib import Path
import socket
import struct
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

import importlib.util
spec = importlib.util.spec_from_file_location('desktop_helper', Path(__file__).with_name('desktop-helper.py'))
h = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)


class FakeConnection:
    def __init__(self, data=b'{"type":"status"}\n', uid=1000):
        self.data, self.uid, self.sent = data, uid, b''

    def getsockopt(self, *_):
        return struct.pack('3i', 42, self.uid, 42)

    def settimeout(self, _):
        pass

    def recv(self, _):
        data, self.data = self.data, b''
        return data

    def sendall(self, data):
        self.sent += data


class HelperTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.store = h.TokenStore(Path(self.temporary.name) / 'private/token.json')
        self.gst = Mock()
        self.gst.ElementFactory.find.return_value = True
        self.portal = Mock()
        self.portal.version.return_value = 4
        self.factory = Mock(return_value=self.portal)
        self.desktop = h.Desktop('/runtime/deploy-desktop.sock', env={'XDG_SESSION_TYPE': 'wayland', 'XDG_CURRENT_DESKTOP': 'GNOME'},
                                 gi_loader=lambda: (Mock(), Mock(), self.gst), portal_factory=self.factory, store=self.store)
        self.desktop.lock_settings = lambda kind: dict(locks=False, idleSeconds=None)

    def test_inventory_wayland_x11_and_missing_plugins(self):
        status = self.desktop.status()
        self.assertTrue(status['available'])
        self.assertTrue(status['portalAvailable'])
        self.assertFalse(status['grantStored'])
        self.assertIn('screen once', status['reason'])
        self.portal.start.assert_not_called()
        self.store.write('private-token')
        self.assertTrue(self.desktop.status()['grantStored'])
        self.desktop.env = {'XDG_SESSION_TYPE': 'x11', 'DISPLAY': ':0', 'XDG_CURRENT_DESKTOP': 'KDE'}
        status = self.desktop.status()
        self.assertEqual(status['desktop'], 'KDE')
        self.assertTrue(status['available'])
        self.assertIsNone(status['grantStored'])
        self.desktop.env = {'WAYLAND_DISPLAY': 'wayland-0', 'DISPLAY': ':0'}
        self.gst.ElementFactory.find.side_effect = lambda name: name != 'pipewiresrc'
        status = self.desktop.status()
        self.assertEqual(status['sessionType'], 'wayland')
        self.assertFalse(status['available'])
        self.assertIn('pipewiresrc', status['reason'])
        self.assertIn('install', status['reason'])

    def test_install_commands_use_distro_package_names(self):
        with patch.object(h.Path, 'read_text', return_value='ID=fedora\n'):
            self.assertIn('dnf install python3-gobject', h.install_command())
            self.assertIn('pipewire-gstreamer', h.install_command())
        with patch.object(h.Path, 'read_text', return_value='ID=ubuntu\n'):
            self.assertIn('apt install python3-gi', h.install_command())
            self.assertIn('gstreamer1.0-pipewire', h.install_command())

    def test_missing_gi_and_old_portal_are_unavailable(self):
        self.desktop.loader = Mock(side_effect=ImportError('No module named gi'))
        self.assertIn('install', self.desktop.status()['reason'])
        self.desktop.loader = lambda: (Mock(), Mock(), self.gst)
        self.portal.version.return_value = 3
        self.assertFalse(self.desktop.status()['available'])
        self.assertIn('version 4', self.desktop.status()['reason'])

    def test_socket_protocol_same_uid_and_malformed_requests(self):
        desktop = Mock()
        desktop.status.return_value = {'available': True}
        for data, uid, pattern in [
                (b'{"type":"status"}\n', 1001, 'same uid'),
                (b'nope\n', 1000, 'Expecting value'),
                (b'[]\n', 1000, 'JSON object'),
                (b'{"type":"inspect","path":"anything"}\n', 1000, 'only type'),
                (b'{"type":"click"}\n', 1000, 'view-only'),
                (b'{}', 1000, 'newline'),
                (b'x' * 5000 + b'\n', 1000, 'too large'),
                (b'{}\n{}\n', 1000, 'one request')]:
            connection = FakeConnection(data, uid)
            h.serve_connection(connection, desktop, 1000, credentials=lambda connection: struct.unpack('3i', connection.getsockopt(None, None, None))[1])
            self.assertIn(pattern, json.loads(connection.sent)['error'])
        desktop.inspect.assert_not_called()
        desktop.status.assert_not_called()
        connection = FakeConnection()
        h.serve_connection(connection, desktop, 1000, credentials=lambda connection: struct.unpack('3i', connection.getsockopt(None, None, None))[1])
        self.assertEqual(json.loads(connection.sent), {'available': True})

    def test_peer_credentials_are_decoded_from_the_kernel_structure(self):
        with patch.object(h.socket, 'SO_PEERCRED', 17, create=True):
            self.assertEqual(h.peer_uid(FakeConnection(uid=1000)), 1000)
            self.assertEqual(h.peer_uid(FakeConnection(uid=0)), 0)

    @unittest.skipUnless(hasattr(socket, 'SO_PEERCRED'), 'Linux kernel credentials only')
    def test_kernel_peer_uid(self):
        left, right = socket.socketpair()
        try:
            self.assertEqual(h.peer_uid(left), os.getuid())
        finally:
            left.close()
            right.close()

    def test_token_storage_is_private_and_rotates(self):
        self.assertIsNone(self.store.read())
        self.store.write('first')
        self.assertEqual(self.store.path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.store.path.parent.stat().st_mode & 0o777, 0o700)
        self.store.write('second')
        self.assertEqual(self.store.read(), 'second')
        self.store.write(None)
        self.assertIsNone(self.store.read())

    def test_locked_screen_returns_message_and_never_opens_stream(self):
        self.desktop.screen_state = Mock(return_value='The desktop is locked or idle')
        result = self.desktop.inspect()
        self.assertEqual(result['screenState'], 'locked-or-idle')
        self.assertNotIn('image', result)
        self.portal.start.assert_not_called()

    def test_screensaver_response_and_unavailable_interface(self):
        gio, glib = Mock(), Mock()
        gio.bus_get_sync.return_value.call_sync.return_value.unpack.return_value = (True,)
        self.assertIn('locked or idle', self.desktop.screen_state(gio, glib))
        gio.bus_get_sync.return_value.call_sync.side_effect = RuntimeError('No service')
        self.assertIsNone(self.desktop.screen_state(gio, glib))

    def test_capture_uses_portal_fd_closes_session_and_rechecks_lock(self):
        self.desktop.screen_state = Mock(side_effect=[None, None])
        fd = os.open(os.devnull, os.O_RDONLY)
        self.portal.start.return_value = (fd, (7, {}))
        self.desktop.frame = Mock(return_value={'image': 'jpeg', 'mimeType': 'image/jpeg'})
        result = self.desktop.inspect()
        self.assertEqual(result['image'], 'jpeg')
        self.desktop.frame.assert_called_once_with(self.gst, fd, (7, {}))
        with self.assertRaises(OSError):
            os.fstat(fd)
        self.assertTrue(self.portal.close.called)
        self.desktop.env = {'XDG_SESSION_TYPE': 'x11'}
        self.desktop.screen_state = Mock(side_effect=[None, 'locked'])
        result = self.desktop.inspect()
        self.assertNotIn('image', result)
        self.assertEqual(result['screenState'], 'locked-or-idle')

    def test_lock_while_waiting_for_a_frame_returns_a_snapshot_message(self):
        self.desktop.env = {'XDG_SESSION_TYPE': 'x11'}
        self.desktop.screen_state = Mock(side_effect=[None, 'Screen locked'])
        self.desktop.frame = Mock(side_effect=RuntimeError('No frame'))
        result = self.desktop.inspect()
        self.assertEqual(result['screenState'], 'locked-or-idle')
        self.assertNotIn('image', result)
        self.assertFalse(self.desktop.capture_lock.locked())

    def test_portal_restore_options_and_fd_are_mocked(self):
        portal = h.Portal.__new__(h.Portal)
        portal.session = None
        portal.GLib = Mock()
        portal.GLib.Variant.side_effect = lambda signature, value: (signature, value)
        portal.Gio = Mock()
        portal.bus = Mock()
        descriptor = Mock()
        descriptor.get.return_value = 22
        reply = Mock()
        reply.unpack.return_value = (0,)
        portal.bus.call_with_unix_fd_list_sync.return_value = (reply, descriptor)
        replies = [dict(session_handle='/session/one'), {}, dict(restore_token='rotated', streams=[(9, {})])]
        portal.request = Mock(side_effect=replies)
        self.store.write('old')
        fd, stream = portal.start(self.store)
        self.assertEqual((fd, stream), (22, (9, {})))
        self.assertEqual(self.store.read(), 'rotated')
        options = portal.request.call_args_list[1].args[2][1]
        self.assertEqual(options['persist_mode'], ('u', 2))
        self.assertEqual(options['restore_token'], ('s', 'old'))
        self.assertEqual(options['types'], ('u', 1))
        self.assertEqual(options['multiple'], ('b', False))
        self.assertEqual(portal.bus.call_with_unix_fd_list_sync.call_args.args[3], 'OpenPipeWireRemote')

    def test_pipeline_uses_only_the_portal_remote_and_stops_after_one_frame(self):
        for properties in [{'pipewire-serial': 1234}, {}]:
            gst = Mock()
            gst.SECOND = 1000000000
            elements = {}
            def make(name, _label):
                element = Mock()
                elements[name] = element
                return element
            gst.ElementFactory.make.side_effect = make
            result_buffer = Mock()
            result_buffer.get_size.return_value = 4
            result_buffer.extract_dup.return_value = b'jpeg'
            # Configure the sink when the pipeline creates it.
            def sink_sample(*_):
                sample = Mock()
                sample.get_buffer.return_value = result_buffer
                sample.get_caps.return_value.get_structure.return_value.get_value.side_effect = lambda name: 1280 if name == 'width' else 720
                return sample
            original_make = make
            def factory(name, label):
                element = original_make(name, label)
                if name == 'appsink':
                    element.emit.side_effect = sink_sample
                return element
            gst.ElementFactory.make.side_effect = factory
            result = self.desktop.frame(gst, 42, (7, properties))
            self.assertEqual(result['width'], 1280)
            self.assertEqual(result['height'], 720)
            self.assertEqual(result['mimeType'], 'image/jpeg')
            source = elements['pipewiresrc']
            source.set_property.assert_any_call('fd', 42)
            if properties:
                source.set_property.assert_any_call('target-object', '1234')
            else:
                source.set_property.assert_any_call('path', '7')
            self.assertNotIn('ximagesrc', elements)
            gst.Pipeline.new.return_value.set_state.assert_called_with(gst.State.NULL)

    def test_host_identity_is_registered_before_any_other_portal_call(self):
        gio, glib = Mock(), Mock()
        glib.Variant.side_effect = lambda signature, args: (signature, args)
        gio.DBusConnectionFlags.AUTHENTICATION_CLIENT = 1
        gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION = 2
        portal = h.Portal(gio, glib)
        call = portal.bus.call_sync.call_args.args
        self.assertEqual(call[2:4], ('org.freedesktop.host.portal.Registry', 'Register'))
        self.assertEqual(call[4], ('(sa{sv})', (h.APP_ID, {})))
        portal.close()

    def test_consumed_token_not_reused_after_denial(self):
        portal = h.Portal.__new__(h.Portal)
        portal.GLib = Mock()
        portal.request = Mock(side_effect=[dict(session_handle='/session/one'), RuntimeError('denied')])
        self.store.write('old')
        with self.assertRaisesRegex(RuntimeError, 'denied'):
            portal.start(self.store)
        self.assertIsNone(self.store.read())

    def test_request_subscribes_before_method_and_cleans_up_on_denial(self):
        portal = h.Portal.__new__(h.Portal)
        portal.GLib, portal.Gio, portal.bus = Mock(), Mock(), Mock()
        portal.bus.get_unique_name.return_value = ':1.2'
        response = Mock()
        response.unpack.return_value = (1, {})
        path = []
        def subscribe(*args):
            path.append(args[3])
            args[6](None, None, None, None, None, response)
            return 10
        portal.bus.signal_subscribe.side_effect = subscribe
        portal.call = Mock(side_effect=lambda *_: (path[0],))
        with self.assertRaisesRegex(RuntimeError, 'cancelled or denied'):
            portal.request('Start', '(osa{sv})', ['/session/one', '', {}])
        portal.bus.signal_unsubscribe.assert_called_once_with(10)

    def test_request_timeout_closes_pending_prompt(self):
        portal = h.Portal.__new__(h.Portal)
        portal.GLib, portal.Gio, portal.bus = Mock(), Mock(), Mock()
        portal.bus.get_unique_name.return_value = ':1.2'
        portal.call = Mock(side_effect=lambda *_args, **_kwargs: (portal.bus.signal_subscribe.call_args.args[3],))
        with patch.object(h.threading, 'Event') as event:
            event.return_value.wait.return_value = False
            with self.assertRaisesRegex(RuntimeError, 'timed out'):
                portal.request('Start', '(osa{sv})', ['/session/one', '', {}])
        self.assertEqual(portal.call.call_args.args[1], 'Close')
        portal.bus.signal_unsubscribe.assert_called_once()


class ScaledCapsTest(unittest.TestCase):
    def test_keeps_aspect_ratio_with_both_dimensions(self):
        self.assertEqual(h.scaled_caps((1728, 1084)), 'video/x-raw,width=1280,height=802,pixel-aspect-ratio=1/1')

    def test_does_not_upscale_small_screens(self):
        self.assertEqual(h.scaled_caps((1024, 768)), 'video/x-raw,width=1024,height=768,pixel-aspect-ratio=1/1')

    def test_unknown_size_is_bounded_in_both_dimensions(self):
        self.assertIn('height=[1,1280]', h.scaled_caps(None))


class ScreenLockTest(unittest.TestCase):
    def gnome(self, values):
        def run(args, **_):
            return Mock(stdout=values[args[-1]] + '\n')
        return run

    def test_gnome_lock_and_idle_delay(self):
        self.assertEqual(h.screen_lock('GNOME', run=self.gnome({'lock-enabled': 'true', 'idle-delay': 'uint32 300'})),
                         dict(locks=True, idleSeconds=300))
        self.assertEqual(h.screen_lock('GNOME', run=self.gnome({'lock-enabled': 'false', 'idle-delay': 'uint32 0'})),
                         dict(locks=False, idleSeconds=None))
        self.assertFalse(h.screen_lock('GNOME', run=self.gnome({'lock-enabled': 'true', 'idle-delay': 'uint32 0'}))['locks'])

    def test_kde_reads_kscreenlockerrc_with_defaults(self):
        with tempfile.TemporaryDirectory() as home:
            self.assertEqual(h.screen_lock('KDE', home=home), dict(locks=True, idleSeconds=300))
            (Path(home) / '.config').mkdir()
            (Path(home) / '.config/kscreenlockerrc').write_text('[Daemon]\nAutolock=false\n')
            self.assertFalse(h.screen_lock('KDE', home=home)['locks'])

    def test_unknown_desktop_or_failure_is_unknown(self):
        def fail(*_, **__):
            raise FileNotFoundError('gsettings')
        self.assertIsNone(h.screen_lock('GNOME', run=fail)['locks'])
        self.assertIsNone(h.screen_lock('sway')['locks'])

    def test_status_says_when_deploy_turned_the_lock_off(self):
        with tempfile.TemporaryDirectory() as state, patch.object(h, 'screen_lock', return_value=dict(locks=False, idleSeconds=None)):
            desktop = h.Desktop('/runtime/deploy-desktop.sock', env={'XDG_STATE_HOME': state})
            self.assertFalse(desktop.lock_settings('GNOME')['changedByDeploy'])
            (Path(state) / 'deploy').mkdir()
            (Path(state) / 'deploy/screen-lock-backup.json').write_text('{}')
            self.assertTrue(desktop.lock_settings('GNOME')['changedByDeploy'])

    def test_notice_names_the_idle_time(self):
        self.assertIn('locks after 5 minutes idle', h.lock_notice(dict(locks=True, idleSeconds=300)))
        self.assertIn('locks after 1 minute idle', h.lock_notice(dict(locks=True, idleSeconds=60)))
        self.assertEqual(h.lock_notice(dict(locks=False, idleSeconds=None)), '')
        self.assertEqual(h.lock_notice(dict(locks=None, idleSeconds=None)), '')


if __name__ == '__main__':
    result = unittest.TextTestRunner().run(unittest.defaultTestLoader.loadTestsFromModule(sys.modules[__name__]))
    if not result.wasSuccessful():
        raise SystemExit(1)
    print('helper tests passed')
