"""Pure central state reducer. Side effects are owned by adapters."""
from dataclasses import dataclass

@dataclass(frozen=True)
class SecurityState:
    armed: bool = False
    active_alerts: int = 0

def apply(state: SecurityState, event: str) -> SecurityState:
    if event == "arm": return SecurityState(True, state.active_alerts)
    if event == "disarm": return SecurityState(False, 0)
    if event == "intrusion" and state.armed: return SecurityState(True, state.active_alerts + 1)
    if event == "clear": return SecurityState(state.armed, 0)
    raise ValueError("unsupported event")
