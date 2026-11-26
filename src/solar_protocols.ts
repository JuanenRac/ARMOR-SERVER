/**
 * The catalogue of the equipment protocols a solar gateway node reads: the same table as ARMOR-COMMON's solar_protocols.json (a test compares them). The server serves it to Studio and
 * takes from it the protocol of each declared family.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
export const SOLAR_PROTOCOLS = {
 "version": 1,
 "note": "The equipment protocols of the solar gateway node. The node, the server and the clients follow this table. 'decoded' means decoded from the public documents and tested on a computer: none has been tried on real equipment unless the compatibility page of the node says so.",
 "protocols": [
  {
   "id": "pi30",
   "label": "Voltronic PI30 (Axpert, PIP, MKS, MAX, EASun SMV)",
   "message": "inverter",
   "port_kind": "voltronic",
   "dialect": "pi30",
   "baud": 2400,
   "framing": "8N1",
   "physical": "rs232",
   "commands": [
    "QPIGS",
    "QMOD",
    "QPIWS",
    "QPIGS2",
    "QPGS",
    "QID",
    "QVFW",
    "QPIRI",
    "QET"
   ],
   "fields": [
    "mode",
    "grid_v",
    "grid_hz",
    "out_v",
    "out_hz",
    "out_va",
    "out_w",
    "load_percent",
    "battery_v",
    "battery_a",
    "battery_percent",
    "pv_v",
    "pv_a",
    "pv_w",
    "heatsink_c",
    "warnings"
   ],
   "status": "decoded",
   "note": "ASCII with CRC-16/XMODEM; covers the PI30 MS/MSX, MAX and PIP-GK/MK variants."
  },
  {
   "id": "pi30-revo",
   "label": "PI30 REVO (checksum replies)",
   "message": "inverter",
   "port_kind": "voltronic",
   "dialect": "revo",
   "baud": 2400,
   "framing": "8N1",
   "physical": "rs232",
   "commands": [
    "QPIGS",
    "QMOD"
   ],
   "fields": [
    "mode",
    "grid_v",
    "grid_hz",
    "out_v",
    "out_hz",
    "out_va",
    "out_w",
    "load_percent",
    "battery_v",
    "battery_a",
    "battery_percent",
    "pv_v",
    "pv_a",
    "pv_w",
    "heatsink_c",
    "warnings"
   ],
   "status": "decoded",
   "note": "No warning list."
  },
  {
   "id": "pi18",
   "label": "Voltronic PI18 (InfiniSolar V, LV5048, SunGoldPower)",
   "message": "inverter",
   "port_kind": "voltronic",
   "dialect": "pi18",
   "baud": 2400,
   "framing": "8N1",
   "physical": "rs232",
   "commands": [
    "^P005GS",
    "^P006MOD",
    "^P005FWS"
   ],
   "fields": [
    "mode",
    "grid_v",
    "grid_hz",
    "out_v",
    "out_hz",
    "out_va",
    "out_w",
    "load_percent",
    "battery_v",
    "battery_a",
    "battery_percent",
    "pv_v",
    "pv_a",
    "pv_w",
    "heatsink_c",
    "warnings"
   ],
   "status": "decoded",
   "note": ""
  },
  {
   "id": "pi41",
   "label": "Voltronic PI41 (LV5048 split phase)",
   "message": "inverter",
   "port_kind": "voltronic",
   "dialect": "pi41",
   "baud": 2400,
   "framing": "8N1",
   "physical": "rs232",
   "commands": [
    "QPIGS",
    "QMOD",
    "QPIWS"
   ],
   "fields": [
    "mode",
    "grid_v",
    "grid_hz",
    "out_v",
    "out_hz",
    "out_va",
    "out_w",
    "load_percent",
    "battery_v",
    "battery_a",
    "battery_percent",
    "pv_v",
    "pv_a",
    "pv_w",
    "heatsink_c",
    "warnings"
   ],
   "status": "partial",
   "note": "First phase only; the warning flags are not named (warnings_known false); QPIGS2 (second phase) is not read."
  },
  {
   "id": "pi34",
   "label": "PI34 MPPT solar charge controller",
   "message": "inverter",
   "port_kind": "voltronic",
   "dialect": "pi34",
   "baud": 2400,
   "framing": "8N1",
   "physical": "rs232",
   "commands": [
    "QPIGS"
   ],
   "fields": [
    "battery_v",
    "battery_a",
    "pv_v",
    "pv_a",
    "pv_w",
    "heatsink_c"
   ],
   "status": "partial",
   "note": "A charger: the AC fields of the message are zero; no mode and no warnings."
  },
  {
   "id": "modbus-smg2",
   "label": "EASun / ISolar SMG II (Modbus RTU)",
   "message": "inverter",
   "port_kind": "modbus",
   "dialect": "smg2",
   "baud": 9600,
   "framing": "8N1",
   "physical": "rs232",
   "commands": [
    "03 201..234",
    "03 100..101",
    "03 108..109"
   ],
   "fields": [
    "mode",
    "grid_v",
    "grid_hz",
    "out_v",
    "out_hz",
    "out_va",
    "out_w",
    "load_percent",
    "battery_v",
    "battery_a",
    "battery_percent",
    "pv_v",
    "pv_a",
    "pv_w",
    "heatsink_c",
    "warnings"
   ],
   "status": "decoded",
   "note": "Slave address 1."
  },
  {
   "id": "modbus-srne-hybrid",
   "label": "SRNE hybrid inverter (Modbus RTU)",
   "message": "inverter",
   "port_kind": "modbus",
   "dialect": "srne-hybrid",
   "baud": 9600,
   "framing": "8N1",
   "physical": "rs232 or rs485",
   "commands": [
    "03 0x0100..0x010E",
    "03 0x0210..0x0221"
   ],
   "fields": [
    "mode",
    "grid_v",
    "grid_hz",
    "out_v",
    "out_hz",
    "out_va",
    "out_w",
    "load_percent",
    "battery_v",
    "battery_a",
    "battery_percent",
    "pv_v",
    "pv_a",
    "pv_w",
    "heatsink_c",
    "warnings"
   ],
   "status": "partial",
   "note": "Register map read from a hard to follow table; needs a capture. No faults."
  },
  {
   "id": "modbus-srne-mppt",
   "label": "SRNE MPPT charge controller (Modbus RTU)",
   "message": "inverter",
   "port_kind": "modbus",
   "dialect": "srne-mppt",
   "baud": 9600,
   "framing": "8N1",
   "physical": "rs232",
   "commands": [
    "03 0x0100..0x0109",
    "03 0x010B..0x010D"
   ],
   "fields": [
    "battery_v",
    "battery_a",
    "battery_percent",
    "pv_v",
    "pv_a",
    "pv_w",
    "heatsink_c",
    "warnings"
   ],
   "status": "partial",
   "note": "A charger: the AC fields are zero; the DC load is not published."
  },
  {
   "id": "vedirect-mppt",
   "label": "Victron VE.Direct solar charger",
   "message": "inverter",
   "port_kind": "vedirect",
   "dialect": "mppt",
   "baud": 19200,
   "framing": "8N1",
   "physical": "ttl 5 V or 3.3 V",
   "commands": [],
   "fields": [
    "mode",
    "battery_v",
    "battery_a",
    "pv_v",
    "pv_a",
    "pv_w",
    "warnings"
   ],
   "status": "decoded",
   "note": "Text mode, listen only. A charger: the AC fields are zero."
  },
  {
   "id": "vedirect-monitor",
   "label": "Victron VE.Direct battery monitor (BMV, SmartShunt)",
   "message": "battery",
   "port_kind": "vedirect",
   "dialect": "monitor",
   "baud": 19200,
   "framing": "8N1",
   "physical": "ttl 5 V or 3.3 V",
   "commands": [],
   "fields": [
    "voltage_v",
    "current_a",
    "soc_percent",
    "temperatures_c"
   ],
   "status": "decoded",
   "note": "Text mode, listen only."
  },
  {
   "id": "pylontech-console",
   "label": "Pylontech battery console",
   "message": "battery",
   "port_kind": "pylontech",
   "dialect": "",
   "baud": 115200,
   "framing": "8N1",
   "physical": "rs232",
   "commands": [
    "pwr",
    "bat",
    "info",
    "stat",
    "soh",
    "data event"
   ],
   "fields": [
    "voltage_v",
    "current_a",
    "soc_percent",
    "cells_v",
    "temperatures_c"
   ],
   "status": "decoded",
   "note": ""
  },
  {
   "id": "ant-bms",
   "label": "ANT-BMS",
   "message": "battery",
   "port_kind": "ant",
   "dialect": "",
   "baud": 19200,
   "framing": "8N1",
   "physical": "ttl 3.3 V",
   "commands": [
    "status frame (old and new)"
   ],
   "fields": [
    "voltage_v",
    "current_a",
    "soc_percent",
    "cells_v",
    "temperatures_c"
   ],
   "status": "decoded",
   "note": ""
  },
  {
   "id": "daly-uart",
   "label": "DALY BMS (UART / RS485)",
   "message": "battery",
   "port_kind": "daly",
   "dialect": "",
   "baud": 9600,
   "framing": "8N1",
   "physical": "ttl 3.3 V or rs485",
   "commands": [
    "0x90",
    "0x93",
    "0x94",
    "0x95",
    "0x96",
    "0x98"
   ],
   "fields": [
    "voltage_v",
    "current_a",
    "soc_percent",
    "cells_v",
    "temperatures_c"
   ],
   "status": "decoded",
   "note": "Failure bits only raise the alarm flag."
  },
  {
   "id": "jbd",
   "label": "JBD / Jiabaida BMS",
   "message": "battery",
   "port_kind": "jbd",
   "dialect": "",
   "baud": 9600,
   "framing": "8N1",
   "physical": "ttl 3.3 V",
   "commands": [
    "DD A5 03",
    "DD A5 04"
   ],
   "fields": [
    "voltage_v",
    "current_a",
    "soc_percent",
    "cells_v",
    "temperatures_c"
   ],
   "status": "decoded",
   "note": ""
  },
  {
   "id": "jk-rs485",
   "label": "JK BMS (RS485 / UART)",
   "message": "battery",
   "port_kind": "jk",
   "dialect": "",
   "baud": 115200,
   "framing": "8N1",
   "physical": "rs485 or ttl",
   "commands": [
    "read all (0x06)"
   ],
   "fields": [
    "voltage_v",
    "current_a",
    "soc_percent",
    "cells_v",
    "temperatures_c"
   ],
   "status": "decoded",
   "note": "Needs a hardware serial port."
  }
 ],
 "not_implemented": [
  {
   "id": "pi00",
   "reason": "Old three-phase family whose frames carry no checksum: a reading could not be verified. Needs a capture."
  },
  {
   "id": "pi16",
   "reason": "Three-phase grid-tie family; its document shows no checksum and its fields do not fit the single-phase message. Needs a capture."
  },
  {
   "id": "pi17",
   "reason": "InfiniSolar 3-phase: the powers are split between ^P003GS and ^P003PS per phase and do not fit the message. Needs a capture."
  },
  {
   "id": "daly-can",
   "reason": "CAN bus: the node has no CAN transceiver."
  },
  {
   "id": "jk-ble",
   "reason": "Bluetooth, not a serial line (JK02 / JK04 frames)."
  },
  {
   "id": "jk-modbus",
   "reason": "The JK PB series speaks Modbus with another register map; not verified against its document."
  },
  {
   "id": "vedirect-hex",
   "reason": "Register protocol for configuration; the text mode already gives the readings."
  },
  {
   "id": "pylontech-rs485",
   "reason": "The frame is built and checked, but the meaning of INFO differs between versions and needs a capture."
  },
  {
   "id": "easun-smt3",
   "reason": "EASun SMT III (HOP, HBAT ...): only reverse-engineered notes with tentative fields and no documented checksum."
  }
 ]
} as const;
