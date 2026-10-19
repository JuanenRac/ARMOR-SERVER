/**
 * The table of the typed operations that write to a Pylontech battery: the same table as ARMOR-COMMON's battery_ops.json (a test compares them), which the node, the server and the
 * clients all follow. Nothing in the server sends a battery a line that is not built from it.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
export const BATTERY_CATALOG = {
 "version": 1,
 "note": "The typed operations that write to a Pylontech battery through its console. The node, the server and the clients all follow this table; the ranges are the ones the maker's own tool states.",
 "ops": [
  {
   "id": "set_clock",
   "risk": "low",
   "needs_idle": false,
   "alarm_ok": false,
   "atomic": false,
   "group": "clock",
   "params": {}
  },
  {
   "id": "clear_stats",
   "risk": "medium",
   "needs_idle": false,
   "alarm_ok": false,
   "atomic": false,
   "group": "maintenance",
   "params": {}
  },
  {
   "id": "clear_log",
   "risk": "medium",
   "needs_idle": false,
   "alarm_ok": false,
   "atomic": false,
   "group": "maintenance",
   "params": {}
  },
  {
   "id": "clear_data",
   "risk": "high",
   "needs_idle": false,
   "alarm_ok": false,
   "atomic": false,
   "group": "maintenance",
   "params": {
    "which": {
     "type": "enum",
     "values": [
      "event",
      "history"
     ],
     "required": true
    }
   }
  },
  {
   "id": "restart",
   "risk": "low",
   "needs_idle": false,
   "alarm_ok": true,
   "atomic": false,
   "group": "maintenance",
   "params": {}
  },
  {
   "id": "shutdown",
   "risk": "medium",
   "needs_idle": false,
   "alarm_ok": true,
   "atomic": false,
   "group": "maintenance",
   "params": {}
  },
  {
   "id": "soc_capacity",
   "risk": "medium",
   "needs_idle": true,
   "alarm_ok": false,
   "atomic": false,
   "group": "soc",
   "params": {}
  },
  {
   "id": "mosfail_test",
   "risk": "medium",
   "needs_idle": true,
   "alarm_ok": false,
   "atomic": false,
   "group": "soc",
   "params": {}
  },
  {
   "id": "soc_reset",
   "risk": "irreversible",
   "needs_idle": true,
   "alarm_ok": false,
   "atomic": true,
   "group": "soc",
   "params": {}
  },
  {
   "id": "pcb_setup",
   "risk": "irreversible",
   "needs_idle": true,
   "alarm_ok": false,
   "atomic": true,
   "group": "soc",
   "params": {
    "serial": {
     "type": "serial",
     "required": true
    }
   }
  },
  {
   "id": "limits_set",
   "risk": "high",
   "needs_idle": true,
   "alarm_ok": false,
   "atomic": false,
   "group": "limits",
   "params": {
    "group": {
     "type": "enum",
     "values": [
      "module_voltage",
      "cell_voltage",
      "temperature"
     ],
     "required": true
    },
    "values": {
     "type": "limits",
     "required": true
    }
   }
  },
  {
   "id": "limits_default",
   "risk": "high",
   "needs_idle": true,
   "alarm_ok": false,
   "atomic": false,
   "group": "limits",
   "params": {}
  },
  {
   "id": "protections_set",
   "risk": "high",
   "needs_idle": true,
   "alarm_ok": false,
   "atomic": false,
   "group": "limits",
   "params": {
    "items": {
     "type": "protections",
     "required": true
    },
    "accept_risk": {
     "type": "boolean",
     "required": false
    }
   }
  },
  {
   "id": "protections_default",
   "risk": "high",
   "needs_idle": true,
   "alarm_ok": false,
   "atomic": false,
   "group": "limits",
   "params": {}
  },
  {
   "id": "output_set",
   "risk": "medium",
   "needs_idle": true,
   "alarm_ok": false,
   "atomic": false,
   "group": "outputs",
   "params": {
    "output": {
     "type": "enum",
     "values": [
      "cfet",
      "dfet",
      "buzz",
      "heat"
     ],
     "required": true
    },
    "state": {
     "type": "enum",
     "values": [
      "on",
      "off"
     ],
     "required": true
    }
   }
  },
  {
   "id": "fault_clear",
   "risk": "medium",
   "needs_idle": false,
   "alarm_ok": true,
   "atomic": false,
   "group": "outputs",
   "params": {}
  },
  {
   "id": "write_barcode",
   "risk": "irreversible",
   "needs_idle": true,
   "alarm_ok": false,
   "atomic": true,
   "group": "eeprom",
   "params": {
    "serial": {
     "type": "serial",
     "required": true
    }
   }
  },
  {
   "id": "eeprom_erase",
   "risk": "irreversible",
   "needs_idle": true,
   "alarm_ok": false,
   "atomic": true,
   "group": "eeprom",
   "params": {
    "restore_barcode": {
     "type": "boolean",
     "required": false
    }
   }
  },
  {
   "id": "firmware_update",
   "risk": "irreversible",
   "needs_idle": true,
   "alarm_ok": false,
   "atomic": true,
   "group": "firmware",
   "params": {
    "image_size": {
     "type": "integer",
     "minimum": 65536,
     "maximum": 524288,
     "required": true
    },
    "image_crc32": {
     "type": "integer",
     "minimum": 0,
     "maximum": 4294967295,
     "required": true
    },
    "image_version": {
     "type": "string",
     "maxLength": 12,
     "required": true
    },
    "clear_eeprom": {
     "type": "boolean",
     "required": false
    }
   }
  },
  {
   "id": "expert_command",
   "risk": "high",
   "needs_idle": false,
   "alarm_ok": false,
   "atomic": false,
   "group": "expert",
   "params": {
    "line": {
     "type": "string",
     "maxLength": 48,
     "required": true
    }
   }
  }
 ],
 "models": [
  {
   "name": "US2000C",
   "official_ah": 50,
   "firmware": true
  },
  {
   "name": "US3000C",
   "official_ah": 74,
   "firmware": true
  },
  {
   "name": "UP5000",
   "official_ah": 100,
   "firmware": true
  },
  {
   "name": "US5000",
   "official_ah": 0,
   "firmware": true
  },
  {
   "name": "US2KBPL",
   "official_ah": 0,
   "firmware": false
  },
  {
   "name": "UP2500",
   "official_ah": 0,
   "firmware": false
  }
 ],
 "limit_groups": [
  {
   "name": "module_voltage",
   "lowest": 20000,
   "highest": 65000,
   "unit": "mV",
   "keys": [
    [
     "pov",
     "pov"
    ],
    [
     "povr",
     "povr"
    ],
    [
     "phv",
     "phv"
    ],
    [
     "phvr",
     "phvr"
    ],
    [
     "plv",
     "plv"
    ],
    [
     "plvr",
     "plvr"
    ],
    [
     "puv",
     "puv"
    ],
    [
     "puvr",
     "puvr"
    ],
    [
     "pslp",
     "pslp"
    ]
   ],
   "orders": [
    [
     "povr",
     "pov"
    ],
    [
     "phv",
     "pov"
    ],
    [
     "phvr",
     "phv"
    ],
    [
     "plv",
     "phv"
    ],
    [
     "puv",
     "plv"
    ],
    [
     "plv",
     "plvr"
    ],
    [
     "puv",
     "puvr"
    ],
    [
     "pslp",
     "puv"
    ]
   ]
  },
  {
   "name": "cell_voltage",
   "lowest": 0,
   "highest": 7000,
   "unit": "mV",
   "keys": [
    [
     "bov",
     "bov"
    ],
    [
     "bovr",
     "bovr"
    ],
    [
     "bhv",
     "bhv"
    ],
    [
     "bhvr",
     "bhvr"
    ],
    [
     "blv",
     "blv"
    ],
    [
     "blvr",
     "blvr"
    ],
    [
     "buv",
     "buv"
    ],
    [
     "buvr",
     "buvr"
    ],
    [
     "bslp",
     "bslp"
    ]
   ],
   "orders": [
    [
     "bovr",
     "bov"
    ],
    [
     "bhv",
     "bov"
    ],
    [
     "bhvr",
     "bhv"
    ],
    [
     "blv",
     "bhv"
    ],
    [
     "buv",
     "blv"
    ],
    [
     "blv",
     "blvr"
    ],
    [
     "buv",
     "buvr"
    ],
    [
     "bslp",
     "buv"
    ]
   ]
  },
  {
   "name": "temperature",
   "lowest": -40000,
   "highest": 100000,
   "unit": "m°C",
   "keys": [
    [
     "cot",
     "bot"
    ],
    [
     "cotr",
     "botr"
    ],
    [
     "cht",
     "bht"
    ],
    [
     "chtr",
     "bhtr"
    ],
    [
     "clt",
     "blt"
    ],
    [
     "cltr",
     "bltr"
    ],
    [
     "cut",
     "but"
    ],
    [
     "cutr",
     "butr"
    ]
   ],
   "orders": [
    [
     "cotr",
     "cot"
    ],
    [
     "cht",
     "cot"
    ],
    [
     "chtr",
     "cht"
    ],
    [
     "clt",
     "cht"
    ],
    [
     "clt",
     "cltr"
    ],
    [
     "cut",
     "clt"
    ],
    [
     "cut",
     "cutr"
    ]
   ]
  }
 ],
 "protections": [
  "bov",
  "bhv",
  "blv",
  "buv",
  "bslp",
  "pov",
  "phv",
  "plv",
  "puv",
  "pslp",
  "coc",
  "coc2",
  "doc",
  "doc2"
 ],
 "expert_blocked": [
  "updata",
  "eepe",
  "eepw",
  "eepr",
  "tbar",
  "tmbar",
  "flaw",
  "flae",
  "mm",
  "login",
  "logout",
  "re",
  "m2s",
  "save",
  "rtcw",
  "socw",
  "soccfg",
  "socclr",
  "urates",
  "setprt",
  "wdg",
  "twdg",
  "tflash",
  "tmpicw"
 ],
 "limits": {
  "idle_current_ma": 1000,
  "arm_window_s": 120,
  "cooldown_s": 30,
  "image_min_bytes": 65536,
  "image_max_bytes": 524288,
  "chunk_bytes": 256,
  "max_chunks": 2048,
  "serial_pattern": "^[A-Za-z0-9_-]{10,24}$",
  "no_serial": "NOSERIAL"
 },
 "refusals": [
  "none",
  "disabled",
  "invalid_params",
  "unknown_op",
  "not_pylontech",
  "no_battery",
  "unknown_model",
  "unknown_firmware",
  "serial_mismatch",
  "serial_unreadable",
  "not_idle",
  "critical_alarm",
  "busy",
  "cooldown",
  "locked",
  "not_armed",
  "bad_token",
  "expired",
  "chip_unknown",
  "image_missing",
  "image_mismatch",
  "unsupported_model",
  "no_official_value",
  "risk_not_accepted",
  "expert_blocked",
  "no_password",
  "battery_changed",
  "clock_not_set",
  "not_cancellable",
  "no_memory",
  "no_answer",
  "login_failed",
  "preflight_failed",
  "stage_invalid",
  "stage_order",
  "stage_data",
  "stage_size",
  "stage_crc"
 ]
} as const;
