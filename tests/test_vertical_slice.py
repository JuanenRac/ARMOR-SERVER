"""Local integration test across the contract, simulator and server repositories."""
from __future__ import annotations

import pathlib
import sys
import unittest

root = pathlib.Path(__file__).resolve().parents[2]
sys.path[:0] = [str(root / "ARMOR-COMMON" / "src"), str(root / "ARMOR-SIMULATOR" / "src"), str(root / "ARMOR-SERVER" / "src")]

from armor_common import decode, encode
from armor_simulator import telemetry
from service import ArmorService


class VerticalSliceTests(unittest.TestCase):
    def test_simulator_contract_server_path(self):
        payload = telemetry("north-1", 3)
        topic, decoded = decode(encode("armor/node/north-1/telemetry", payload))
        service = ArmorService()
        service.ingest(topic, decoded)
        status = service.status()
        self.assertEqual(status["nodes"]["north-1"]["target_count"], 1)
        self.assertGreater(status["nodes"]["north-1"]["lux"], 0)
