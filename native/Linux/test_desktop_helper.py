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
        desktop.allow_input = False
        desktop.status.return_value = {'available': True}
        for data, uid, pattern in [
                (b'{"type":"status"}\n', 1001, 'same uid'),
                (b'nope\n', 1000, 'Expecting value'),
                (b'[]\n', 1000, 'JSON object'),
                (b'{"type":"status","x":1}\n', 1000, 'only type'),
                (b'{"type":"inspect","path":"anything"}\n', 1000, 'Unexpected fields for inspect: path'),
                (b'{"type":"click","x":1,"y":2}\n', 1000, 'view-only'),
                (b'{"type":"click","x":1,"y":2}\n', 1000, '--allow-input'),
                (b'{"type":"navigate"}\n', 1000, 'Supported requests'),
                (b'{}', 1000, 'newline'),
                (b'x' * 70000 + b'\n', 1000, 'too large'),
                (b'{}\n{}\n', 1000, 'one request')]:
            connection = FakeConnection(data, uid)
            h.serve_connection(connection, desktop, 1000, credentials=lambda connection: struct.unpack('3i', connection.getsockopt(None, None, None))[1])
            self.assertIn(pattern, json.loads(connection.sent)['error'])
        desktop.inspect.assert_not_called()
        desktop.act.assert_not_called()
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


class InputTests(unittest.TestCase):
    """RemoteDesktop input, opted into with --allow-input. The portal is always mocked."""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.store = h.TokenStore(Path(self.temporary.name) / 'private/token.json')
        self.gst = Mock()
        self.gst.ElementFactory.find.return_value = True
        self.portal = Mock()
        self.portal.version.return_value = 4
        self.portal.device_types.return_value = 7
        self.factory = Mock(return_value=self.portal)
        self.desktop = h.Desktop('/runtime/deploy-desktop.sock', env={'XDG_SESSION_TYPE': 'wayland', 'XDG_CURRENT_DESKTOP': 'GNOME'},
                                 gi_loader=lambda: (Mock(), Mock(), self.gst), portal_factory=self.factory, store=self.store,
                                 allow_input=True)
        self.desktop.lock_settings = lambda kind: dict(locks=False, idleSeconds=None)
        self.desktop.screen_state = Mock(return_value=None)
        self.desktop.frame = Mock(side_effect=lambda *_: {'image': 'jpeg', 'mimeType': 'image/jpeg', 'width': 1280, 'height': 720,
                                                          'text': 'Desktop screenshot (view-only)'})
        self.stream = (31, {'size': (2560, 1440)})
        self.portal.start.side_effect = lambda *_args, **_kwargs: (os.open(os.devnull, os.O_RDONLY), self.stream)
        patcher = patch.object(h.time, 'sleep')
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_view_only_is_the_default(self):
        desktop = h.Desktop('/sock', env={'XDG_SESSION_TYPE': 'wayland'}, gi_loader=lambda: (Mock(), Mock(), self.gst),
                            portal_factory=self.factory, store=self.store)
        desktop.lock_settings = lambda kind: dict(locks=False, idleSeconds=None)
        status = desktop.status()
        self.assertFalse(status['inputAllowed'])
        self.assertTrue(status['viewOnly'])
        self.portal.device_types.assert_not_called()
        with self.assertRaisesRegex(RuntimeError, 'view-only'):
            desktop.act({'type': 'click', 'x': 1, 'y': 1})
        self.portal.start.assert_not_called()

    def test_status_reports_input_allowed_and_says_so_plainly(self):
        with patch.object(h.socket, 'gethostname', return_value='ser'):
            status = self.desktop.status()
            self.assertTrue(status['inputAllowed'])
            self.assertFalse(status['viewOnly'])
            self.assertFalse(status['grantStored'])
            self.assertIn('Approve remote control on ser’s screen once', status['reason'])
            self.assertIn('approved agents can click and type on ser', status['reason'])
            # A view-only grant cannot restore a remote desktop session.
            self.store.write('cast-token')
            self.assertFalse(self.desktop.status()['grantStored'])
            self.store.write('remote-token', 'remote-desktop')
            status = self.desktop.status()
            self.assertTrue(status['grantStored'])
            self.assertNotIn('Approve', status['reason'])
        self.portal.version.assert_any_call(h.REMOTE)

    def test_input_falls_back_to_view_only_when_unsupported(self):
        for version, devices, pattern in [(1, 7, 'version 2'), (2, 1, 'keyboard and pointer')]:
            self.portal.version.side_effect = lambda interface=h.CAST: version if interface == h.REMOTE else 4
            self.portal.device_types.return_value = devices
            status = self.desktop.status()
            self.assertTrue(status['available'])
            self.assertFalse(status['inputAllowed'])
            self.assertTrue(status['viewOnly'])
            self.assertIn(pattern, status['reason'])
        self.portal.device_types.side_effect = RuntimeError('No such interface')
        self.assertIn('no RemoteDesktop', self.desktop.status()['inputReason'])
        with self.assertRaisesRegex(RuntimeError, 'no RemoteDesktop'):
            self.desktop.act({'type': 'text', 'text': 'hi', 'expectedBounds': {'x': 0, 'y': 0, 'width': 1280, 'height': 720}})
        self.desktop.env = {'XDG_SESSION_TYPE': 'x11', 'DISPLAY': ':0'}
        status = self.desktop.status()
        self.assertFalse(status['inputAllowed'])
        self.assertIn('X11', status['reason'])
        self.portal.start.assert_not_called()

    def test_request_validation_rejects_bad_input_before_the_portal(self):
        for request, pattern in [
                ({'type': 'click', 'x': 1}, 'requires x, y'),
                ({'type': 'click', 'x': 'a', 'y': 1}, 'Finite'),
                ({'type': 'click', 'x': True, 'y': 1}, 'Finite'),
                ({'type': 'scroll', 'x': 0, 'y': 20000}, 'Finite'),
                ({'type': 'text', 'text': 'x' * 8001}, '8000'),
                ({'type': 'text', 'text': 7}, '8000'),
                ({'type': 'press', 'key': 'F13'}, 'Supported desktop keys'),
                ({'type': 'press', 'key': 'Enter', 'targetId': 'desktop'}, 'Unexpected fields'),
                ({'type': 'click', 'x': 1, 'y': 1, 'expectedBounds': {'width': 1280, 'height': 720}}, 'expectedBounds')]:
            with self.assertRaisesRegex(ValueError, pattern):
                h.dispatch(request, self.desktop)
        self.portal.start.assert_not_called()

    def test_click_maps_frame_pixels_to_the_stream(self):
        result = h.dispatch({'type': 'click', 'x': 640, 'y': 180, 'expectedBounds': {'x': 0, 'y': 0, 'width': 1280, 'height': 720}}, self.desktop)
        self.assertEqual(self.portal.start.call_args.kwargs, {'remote': True})
        self.portal.pointer_motion.assert_called_once_with(31, 1280.0, 360.0)
        self.assertEqual(self.portal.pointer_button.call_args_list, [((h.BTN_LEFT, True),), ((h.BTN_LEFT, False),)])
        self.assertEqual(result['inputBounds'], {'x': 0, 'y': 0, 'width': 1280, 'height': 720})
        self.assertIn('Clicked at 640, 180', result['text'])
        self.assertIn('untrusted', result['text'])
        self.assertTrue(self.portal.close.called)
        self.assertFalse(self.desktop.capture_lock.locked())
        with self.assertRaisesRegex(ValueError, 'outside the 1280×720 screenshot'):
            h.dispatch({'type': 'click', 'x': 1280, 'y': 10, 'expectedBounds': {'x': 0, 'y': 0, 'width': 1280, 'height': 720}}, self.desktop)

    def test_text_keys_and_scroll(self):
        bounds = {'expectedBounds': {'x': 0, 'y': 0, 'width': 1280, 'height': 720}}
        result = self.desktop.act({'type': 'text', 'text': 'Hé\r\n€', **bounds})
        pressed = [call.args[0] for call in self.portal.keysym.call_args_list if call.args[1]]
        released = [call.args[0] for call in self.portal.keysym.call_args_list if not call.args[1]]
        self.assertEqual(pressed, [ord('H'), 0xe9, 0xff0d, 0x010020ac])
        self.assertEqual(released, pressed)
        self.assertIn('Typed 4 characters', result['text'])
        self.portal.keysym.reset_mock()
        self.desktop.act({'type': 'press', 'key': 'Escape', **bounds})
        self.assertEqual(self.portal.keysym.call_args_list, [((0xff1b, True),), ((0xff1b, False),)])
        self.desktop.act({'type': 'scroll', 'x': 0, 'y': 240, **bounds})
        self.portal.axis.assert_called_once_with(0, 240)
        with self.assertRaisesRegex(ValueError, 'control character'):
            h.text_keysyms('a\x07')

    def test_input_is_refused_without_matching_bounds_or_on_a_locked_screen(self):
        with self.assertRaisesRegex(RuntimeError, 'inspect again'):
            self.desktop.act({'type': 'click', 'x': 1, 'y': 1})
        with self.assertRaisesRegex(RuntimeError, 'screen size changed'):
            self.desktop.act({'type': 'click', 'x': 1, 'y': 1, 'expectedBounds': {'x': 0, 'y': 0, 'width': 1280, 'height': 800}})
        self.desktop.screen_state = Mock(side_effect=[None, 'The desktop is locked or idle.', 'The desktop is locked or idle.'])
        with self.assertRaisesRegex(RuntimeError, 'No input was sent'):
            self.desktop.act({'type': 'text', 'text': 'password', 'expectedBounds': {'x': 0, 'y': 0, 'width': 1280, 'height': 720}})
        self.desktop.screen_state = Mock(return_value='The desktop is locked or idle.')
        with self.assertRaisesRegex(RuntimeError, 'No input was sent'):
            self.desktop.act({'type': 'press', 'key': 'Enter', 'expectedBounds': {'x': 0, 'y': 0, 'width': 1280, 'height': 720}})
        self.portal.pointer_motion.assert_not_called()
        self.portal.keysym.assert_not_called()
        self.assertFalse(self.desktop.capture_lock.locked())

    def test_inspect_uses_the_remote_session_and_reports_bounds(self):
        result = self.desktop.inspect()
        self.assertEqual(self.portal.start.call_args.kwargs, {'remote': True})
        self.assertEqual(result['inputBounds'], {'x': 0, 'y': 0, 'width': 1280, 'height': 720})
        self.assertIn('Capture only', result['text'])
        self.portal.pointer_motion.assert_not_called()

    def test_remote_session_selects_devices_and_persists_through_them(self):
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
        portal.request = Mock(side_effect=[dict(session_handle='/session/one'), {}, {},
                                           dict(restore_token='rotated', devices=3, streams=[(9, {'size': (1920, 1080)})])])
        self.store.write('cast-only')
        self.store.write('old', 'remote-desktop')
        fd, stream = portal.start(self.store, remote=True)
        self.assertEqual((fd, stream[0]), (22, 9))
        calls = portal.request.call_args_list
        self.assertEqual([(c.args[0], c.args[3]) for c in calls],
                         [('CreateSession', h.REMOTE), ('SelectDevices', h.REMOTE), ('SelectSources', h.CAST), ('Start', h.REMOTE)])
        devices = calls[1].args[2][1]
        self.assertEqual(devices['types'], ('u', h.KEYBOARD | h.POINTER))
        self.assertEqual(devices['persist_mode'], ('u', 2))
        self.assertEqual(devices['restore_token'], ('s', 'old'))
        self.assertNotIn('persist_mode', calls[2].args[2][1])
        self.assertEqual(self.store.read('remote-desktop'), 'rotated')
        self.assertIsNone(self.store.read())
        # Input access the owner did not grant is an error, never a silent view-only session.
        portal.request = Mock(side_effect=[dict(session_handle='/session/two'), {}, {},
                                           dict(restore_token='next', devices=1, streams=[(9, {})])])
        with self.assertRaisesRegex(RuntimeError, 'keyboard and pointer'):
            portal.start(self.store, remote=True)

    def test_notify_calls_use_the_session_and_portal_signatures(self):
        portal = h.Portal.__new__(h.Portal)
        portal.session = '/session/one'
        portal.GLib = Mock()
        portal.GLib.Variant.side_effect = lambda signature, value: (signature, value)
        portal.call = Mock()
        portal.pointer_motion(31, 10, 20)
        portal.pointer_button(h.BTN_LEFT, True)
        portal.keysym(0xff0d, False)
        portal.axis(0, -120)
        self.assertEqual([c.args for c in portal.call.call_args_list], [
            (h.REMOTE, 'NotifyPointerMotionAbsolute', '(oa{sv}udd)', ('/session/one', {}, 31, 10.0, 20.0)),
            (h.REMOTE, 'NotifyPointerButton', '(oa{sv}iu)', ('/session/one', {}, 0x110, 1)),
            (h.REMOTE, 'NotifyKeyboardKeysym', '(oa{sv}iu)', ('/session/one', {}, 0xff0d, 0)),
            (h.REMOTE, 'NotifyPointerAxis', '(oa{sv}dd)', ('/session/one', {'finish': ('b', True)}, 0.0, -120.0))])


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
