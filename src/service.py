"""In-memory, side-effect-free ingestion service for the first vertical slice."""
from __future__ import annotations

from collections.abc import Mapping
from dataclasses import asdict, dataclass, field

from state import SecurityState, apply


@dataclass
class NodeSnapshot:
    timestamp_ms: int
    lux: float | None = None
    online: bool | None = None
    target_count: int = 0


@dataclass
class ArmorService:
    state: SecurityState = field(default_factory=SecurityState)
    nodes: dict[str, NodeSnapshot] = field(default_factory=dict)

    def ingest(self, topic: str, payload: Mapping[str, object]) -> None:
        """Apply pre-validated telemetry or health; never execute field commands."""
        _, _, node_id, kind = topic.split("/")
        timestamp = int(payload["timestamp_ms"]) if kind != "command" else 0
        if kind == "telemetry":
            self.nodes[node_id] = NodeSnapshot(timestamp, float(payload["lux"]), target_count=len(payload["targets"]))
        elif kind == "health":
            previous = self.nodes.get(node_id, NodeSnapshot(timestamp))
            previous.timestamp_ms, previous.online = timestamp, bool(payload["online"])
            self.nodes[node_id] = previous
        else:
            raise ValueError("field commands require an authenticated command adapter")

    def command(self, event: str) -> SecurityState:
        self.state = apply(self.state, event)
        return self.state

    def status(self) -> dict[str, object]:
        return {"security": asdict(self.state), "nodes": {node: asdict(snapshot) for node, snapshot in sorted(self.nodes.items())}}
