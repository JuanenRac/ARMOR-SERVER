import sys, unittest
import json
from urllib.request import urlopen
from threading import Thread
sys.path.insert(0, "src")
from state import SecurityState, apply
from service import ArmorService
from http_api import serve
class StateTests(unittest.TestCase):
    def test_intrusion_requires_arm(self): self.assertEqual(apply(SecurityState(), "arm"), SecurityState(True, 0))
    def test_disarm_clears_alerts(self): self.assertEqual(apply(SecurityState(True, 2), "disarm"), SecurityState(False, 0))
    def test_keeps_latest_node_snapshot(self):
        service = ArmorService()
        service.ingest("armor/node/north-1/telemetry", {"timestamp_ms": 8, "lux": 12, "targets": []})
        self.assertEqual(service.status()["nodes"]["north-1"]["lux"], 12.0)

    def test_read_only_status_api(self):
        server = serve(ArmorService(), port=0)
        thread = Thread(target=server.handle_request)
        thread.start()
        with urlopen(f"http://127.0.0.1:{server.server_port}/healthz") as response:
            self.assertTrue(json.loads(response.read())["ok"])
        thread.join()
        server.server_close()
