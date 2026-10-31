# Arming modes

The server arms in three ways: **away** (everything is defended: the `armed` of always), **home** and **night** (only what the owner marked for that mode). All of it is behind the setting `alarm.arming_modes`, **off by default**: off, the server arms and disarms exactly as it always did and a client sees no new field. The contract is in ARMOR-COMMON (`arming_modes.schema.json`, `docs/CONTRACTS.md`, the routes in `openapi/armor-server.yaml`); the code is `src/arming_modes.ts`, `src/routes/alarm_modes.ts` and the `POST /api/v1/mode` route in `src/routes/alarms.ts`.

## The model

* **What a mode defends** is a list of references: `zone:<location>` (every device whose location is that text, case ignored), `device:<id>`, `node:<id>` and `camera:<id>`. Away defends every device, node and camera. Home and night **start with nothing assigned**; the owner assigns zones and sensors in the alarm designer (`PUT /api/v1/alarm/modes`).
* **What "defended" means** is what the armed system already did, now per thing: an intrusion sensor (door, window, motion, glass break, vibration) raises its alarm, a radar node raises the intrusion alert, and a node or camera that goes silent raises its warning, **only if the mode in force defends it**. Smoke, gas, flood, panic and tamper (the `always` alarms), batteries, energy, network and the rest never depend on the mode.
* **Delays per mode:** `exit_delay_s` (after arming from disarmed, or changing to a mode, what the new mode defends and the old one did not is not yet guarded; when the delay ends, what is still wrong sounds) and `entry_delay_s` (the sensors listed in `entry` wait that long before they sound; a disarm in time stops them; a sensor that is back to normal when its delay ends still leaves its alarm in the record, already ended). The entry delay applies to devices; a node or a camera sounds at once.
* **The timetable** (`schedule`, up to 16 entries: mode, days 1 to 7, `HH:MM` in the time zone of the server, `ARMOR_TZ`) runs only while `alarm.mode_schedule` is on. It **never disarms**; it skips a change to a mode that defends less than the current one unless `alarm.mode_schedule_lowers` is on; it never arms a mode with nothing assigned. What it did or skipped is in the audit trail (`control.mode_schedule`, actor `schedule`).
* **The state:** `mode` stays `armed` or `disarmed` (an older client reads it), and `arming_mode` (`disarmed`, `away`, `home`, `night`) is added while the modes are on. A system that is armed by a client that knows no modes (`armed`, the control API, the voice assistant) is **away**: the most it can defend.

## Who may change the mode, and what is checked

`POST /api/v1/mode` takes `armed` (= away), `disarmed`, `away`, `home` and `night`, with `pin` and `confirm_unassigned`. Access is the one of arming and disarming: an operator or an administrator (a viewer cannot), the PIN with its lockout and the duress PIN, and the audit trail (`control.arm`, `control.disarm`, `control.mode`).

| Case | Answer |
| --- | --- |
| `home` or `night` while the modes are off | `400 modes_disabled` |
| a mode that defends nothing (no reference matches any device, node or camera) | `409 no_zones_assigned`; with `confirm_unassigned: true` it is armed and the audit says "nothing assigned, confirmed" |
| a change to a mode that defends **less** than the current one (some thing defended now is not defended by the target) | needs the PIN of a disarm (`403 wrong_pin`, `429 pin_locked`, `403 pin_not_set` as for a disarm); the duress PIN lets it through and raises the silent alarm; off with `alarm.mode_downgrade_pin: not_required` (default `required`) |
| a change to a mode that defends the same or more, or arming from disarmed | no PIN, as arming has always been |
| `disarmed` | always works with the PIN rules of a disarm (`alarm.disarm_pin`); it stops the exit and entry delays and ends the intrusion alarms |

When the mode changes between two armed modes, what the new mode does not defend stops being an alarm (it goes to the record, settled by "mode", as a disarm does) and what it defends and is wrong sounds.

## Settings (Studio, Security)

| Setting | Default | Lowers the security when |
| --- | --- | --- |
| `alarm.arming_modes` | off | never (it adds ways of arming) |
| `alarm.mode_downgrade_pin` | `required` | set to `not_required` |
| `alarm.mode_schedule` | off | never |
| `alarm.mode_schedule_lowers` | off | turned on |

## Assumptions and what it does NOT do

* The alarm panel of an ARMOR-NODE-ALARM node keeps its own zones, delays, PIN and lockout, and `POST /api/v1/alarm/command` and the arming profiles (`/api/v1/alarm/profiles`) are untouched: the modes decide what **the server** defends, the profile decides what the **panel** does when it is armed. Choosing a mode does not arm a panel; tying the two together is not done.
* It does **not** touch firmware, `firmware_base`, the HMI or any node display: a wall panel or a node shows `armed` or `disarmed` as before. The studio, the apps and the simulator learn the modes in a later step.
* The notifier still words "offline while the system is armed" for a node or a camera outside the mode; only the alarm centre and the intrusion level of a radar node follow the mode.
* The exit delay does not apply to arming by the control API or the voice assistant (they arm away at once). An intrusion that comes and goes inside the exit delay is not remembered.
* The timetable runs in the clock of the server; if the server is off at the minute, that change is lost (it is not replayed).
* The mode in force is kept in `arming-modes.json` with the definitions; a file that cannot be read means home and night defend nothing (so asking for one is refused) and the mode follows the stored armed state as away.
* Not tried on a real installation yet: the tests play the sensors, nodes and timers on the host.
