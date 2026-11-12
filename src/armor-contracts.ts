/** Generated from the A.R.M.O.R. JSON Schemas by tools/generate_types.py. Do not edit. */

export type RadarTrack = {
  sensor_id: number;
  track_id: number;
  x_mm: number;
  y_mm: number;
  speed_mm_s: number;
};

export type Telemetry = {
  kind?: "telemetry";
  node_id: string;
  timestamp_ms: number;
  lux: number;
  targets: RadarTrack[];
};

export type Health = {
  node_id: string;
  timestamp_ms: number;
  online: boolean;
  kind?: "radar" | "panel";
};

export type Command = {
  kind?: "command";
  node_id: string;
  timestamp_ms: number;
  command: "calibrate" | "set_thresholds" | "restart";
  sensitivity?: number;
};

export type Info = {
  kind?: "info";
  node_id: string;
  timestamp_ms: number;
  name: string;
  firmware: string;
  ip: string;
  port: number;
  contract?: string;
};

export type SolarInverterUnits = {
  unit: number;
  serial?: string;
  mode: "power_on" | "standby" | "line" | "battery" | "fault" | "power_saving" | "shutdown" | "unknown";
  fault_code?: string;
  grid_v?: number;
  out_v?: number;
  out_va?: number;
  out_w?: number;
  load_percent?: number;
  battery_v?: number;
  battery_percent?: number;
  pv_v?: number;
  charging_a?: number;
};

export type SolarInverterRatings = {
  grid_rating_v?: number;
  out_rating_v?: number;
  out_rating_hz?: number;
  out_rating_va?: number;
  out_rating_w?: number;
  battery_rating_v?: number;
  battery_recharge_v?: number;
  battery_under_v?: number;
  battery_bulk_v?: number;
  battery_float_v?: number;
  max_charge_a?: number;
  max_ac_charge_a?: number;
  battery_type?: "agm" | "flooded" | "user";
  input_range?: "appliance" | "ups";
  output_priority?: "utility_first" | "solar_first" | "sbu";
  charger_priority?: "utility_first" | "solar_first" | "solar_and_utility" | "solar_only";
};

export type SolarInverter = {
  kind: "inverter";
  node_id: string;
  device: string;
  timestamp_ms: number;
  mode: "power_on" | "standby" | "line" | "battery" | "fault" | "power_saving" | "shutdown" | "unknown";
  grid_v: number;
  grid_hz: number;
  out_v: number;
  out_hz: number;
  out_va: number;
  out_w: number;
  load_percent: number;
  battery_v: number;
  battery_a: number;
  battery_percent: number;
  pv_v: number;
  pv_a: number;
  pv_w: number;
  heatsink_c: number;
  ac_charging: boolean;
  pv_charging: boolean;
  load_on: boolean;
  warnings: string[];
  warnings_known?: boolean;
  clamped?: string[];
  pv2_v?: number;
  pv2_a?: number;
  pv2_w?: number;
  total_out_w?: number;
  total_out_va?: number;
  total_load_percent?: number;
  total_charging_a?: number;
  units?: SolarInverterUnits[];
  bus_v?: number;
  serial?: string;
  firmware?: string;
  pv_energy_total_wh?: number;
  ratings?: SolarInverterRatings;
};

export type SolarModuleLastEvent = {
  index: number;
  time: string;
  voltage_v?: number;
  current_a?: number;
  temperature_c?: number;
  percent?: number;
  base_state?: string;
  voltage_state?: string;
  current_state?: string;
  temperature_state?: string;
  coulomb_state?: string;
  power_events?: string;
  battery_events?: string;
  system_fault?: string;
};

export type SolarModule = {
  n: number;
  present: boolean;
  voltage_v?: number;
  current_a?: number;
  temperature_c?: number;
  soc_percent?: number;
  state?: string;
  cells_v?: number[];
  counters?: Record<string, number>;
  temperatures_c?: number[];
  capacity_ah?: number;
  full_capacity_ah?: number;
  cycles?: number;
  health_percent?: number;
  model?: string;
  cell_count?: number;
  max_charge_a?: number;
  max_discharge_a?: number;
  console_baud?: number;
  soh_counts?: number[];
  soh_abnormal?: number[];
  last_event?: SolarModuleLastEvent;
  board_version?: string;
  main_soft_version?: string;
  soft_version?: string;
};

export type SolarBattery = {
  kind: "battery";
  node_id: string;
  device: string;
  timestamp_ms: number;
  modules: number;
  state?: "charging" | "discharging" | "idle";
  voltage_v?: number;
  current_a?: number;
  temperature_min_c?: number;
  temperature_max_c?: number;
  cell_min_v?: number;
  cell_max_v?: number;
  soc_percent?: number;
  alarm?: boolean;
  stack: SolarModule[];
  model?: string;
  capacity_ah?: number;
  full_capacity_ah?: number;
  energy_kwh?: number;
  cycles?: number;
  health_percent?: number;
  power_w?: number;
  balancing?: number;
  protecting?: boolean;
  charge_mos?: number;
  discharge_mos?: number;
};

export type ElectricalChannel = {
  id: string;
  domain: "ac" | "dc";
  label?: string;
  voltage_v?: number;
  current_a?: number;
  power_w?: number;
  energy_kwh?: number;
  reading_age_ms?: number;
  errors?: number;
  power_estimated?: boolean;
  frequency_hz?: number;
  power_factor?: number;
  state?: "closed" | "open" | "unknown";
  alarm?: boolean;
  alarm_code?: string;
};

export type ElectricalSwitch = {
  id: string;
  kind: "transfer";
  label?: string;
  source_a?: string;
  source_b?: string;
  a_closed: boolean;
  b_closed: boolean;
  selected: "none" | "a" | "b";
  wanted: "none" | "a" | "b";
  closing: boolean;
  armed: boolean;
  fault: "none" | "did_not_close" | "did_not_open" | "both_closed" | "disabled";
};

export type Electrical = {
  kind: "electrical";
  node_id: string;
  timestamp_ms: number;
  switching_enabled?: boolean;
  channels: ElectricalChannel[];
  switches?: ElectricalSwitch[];
};

export type ElectricalCommand = {
  kind: "electrical_command";
  node_id: string;
  timestamp_ms: number;
  command_id: string;
  switch: string;
  action: "arm" | "close_a" | "close_b" | "open" | "acknowledge";
  token?: string;
};

export type ElectricalResult = {
  kind: "electrical_result";
  node_id: string;
  timestamp_ms: number;
  command_id: string;
  switch: string;
  action: "arm" | "close_a" | "close_b" | "open" | "acknowledge";
  accepted: boolean;
  refusal: "none" | "disabled" | "fault" | "not_armed" | "not_confirmed_open" | "unknown_switch" | "bad_token" | "not_supported";
  token?: string;
};

export type SolarBatteryStage = {
  id: string;
  index: number;
  total: number;
  size: number;
  crc32: number;
  data: string;
};

export type SolarBatteryCommandParamsValues = {
  pov?: number;
  povr?: number;
  phv?: number;
  phvr?: number;
  plv?: number;
  plvr?: number;
  puv?: number;
  puvr?: number;
  pslp?: number;
  bov?: number;
  bovr?: number;
  bhv?: number;
  bhvr?: number;
  blv?: number;
  blvr?: number;
  buv?: number;
  buvr?: number;
  bslp?: number;
  cot?: number;
  cotr?: number;
  cht?: number;
  chtr?: number;
  clt?: number;
  cltr?: number;
  cut?: number;
  cutr?: number;
};

export type SolarBatteryCommandParamsItems = {
  bov?: "en" | "dis";
  bhv?: "en" | "dis";
  blv?: "en" | "dis";
  buv?: "en" | "dis";
  bslp?: "en" | "dis";
  pov?: "en" | "dis";
  phv?: "en" | "dis";
  plv?: "en" | "dis";
  puv?: "en" | "dis";
  pslp?: "en" | "dis";
  coc?: "en" | "dis";
  coc2?: "en" | "dis";
  doc?: "en" | "dis";
  doc2?: "en" | "dis";
};

export type SolarBatteryCommandParams = {
  which?: "event" | "history";
  group?: "module_voltage" | "cell_voltage" | "temperature";
  values?: SolarBatteryCommandParamsValues;
  items?: SolarBatteryCommandParamsItems;
  accept_risk?: boolean;
  output?: "cfet" | "dfet" | "buzz" | "heat";
  state?: "on" | "off";
  serial?: string;
  restore_barcode?: boolean;
  image_size?: number;
  image_crc32?: number;
  image_version?: string;
  clear_eeprom?: boolean;
  line?: string;
};

export type SolarBatteryCommand = {
  kind: "solar_battery_command";
  node_id: string;
  timestamp_ms: number;
  command_id: string;
  port: number;
  action: "arm" | "execute" | "cancel" | "stage";
  op?: "set_clock" | "clear_stats" | "clear_log" | "clear_data" | "restart" | "shutdown" | "soc_capacity" | "mosfail_test" | "soc_reset" | "pcb_setup" | "limits_set" | "limits_default" | "protections_set" | "protections_default" | "output_set" | "fault_clear" | "write_barcode" | "eeprom_erase" | "firmware_update" | "expert_command";
  params?: SolarBatteryCommandParams;
  serial?: string;
  token?: string;
  stage?: SolarBatteryStage;
};

export type SolarBatteryIdentity = {
  model: string;
  serial: string;
  soft_version: string;
  board: string;
  capacity_ah?: number;
};

export type SolarBatteryResult = {
  kind: "solar_battery_result";
  node_id: string;
  timestamp_ms: number;
  command_id: string;
  port: number;
  action: "arm" | "execute" | "cancel" | "stage";
  op?: string;
  stage: "armed" | "started" | "progress" | "cancel_requested" | "final" | "rejected" | "staged";
  accepted: boolean;
  refusal: "none" | "disabled" | "invalid_params" | "unknown_op" | "not_pylontech" | "no_battery" | "unknown_model" | "unknown_firmware" | "serial_mismatch" | "serial_unreadable" | "not_idle" | "critical_alarm" | "busy" | "cooldown" | "locked" | "not_armed" | "bad_token" | "expired" | "chip_unknown" | "image_missing" | "image_mismatch" | "unsupported_model" | "no_official_value" | "risk_not_accepted" | "expert_blocked" | "no_password" | "battery_changed" | "clock_not_set" | "not_cancellable" | "no_memory" | "no_answer" | "login_failed" | "preflight_failed" | "stage_invalid" | "stage_order" | "stage_data" | "stage_size" | "stage_crc";
  token?: string;
  canonical?: string;
  summary?: string;
  risk?: "low" | "medium" | "high" | "irreversible";
  atomic?: boolean;
  battery?: SolarBatteryIdentity;
  snapshot_before?: string;
  outcome?: "running" | "ok" | "failed" | "partial" | "retry" | "rejected";
  code?: string;
  steps_done?: number;
  steps_total?: number;
  writes_done?: number;
  packets_sent?: number;
  packets_total?: number;
  truncated?: boolean;
  before?: string;
  after?: string;
  transcript?: string;
  received?: number;
};

export type NodeControlCommand = {
  kind: "node_control_command";
  node_id: string;
  timestamp_ms: number;
  command_id: string;
  action: "arm" | "execute";
  operation: "restart" | "pause" | "resume" | "standby" | "identify" | "diagnostics" | "maintenance_on" | "maintenance_off";
  mode: "now" | "rolling";
  delay_s?: number;
  slot?: number;
  duration_s?: number;
  token?: string;
  requested_by: string;
  detail?: "package" | "log";
};

export type NodeControlResultDiagnosticsPackageHeap = {
  internal_free: number;
  internal_min: number;
  internal_largest: number;
  total_free: number;
  total_min: number;
  psram_free?: number;
};

export type NodeControlResultDiagnosticsPackageTasks = {
  name: string;
  stack_free: number;
  priority: number;
  state: "R" | "r" | "B" | "S" | "D" | "?";
};

export type NodeControlResultDiagnosticsPackageResets = {
  reason: "power_on" | "external" | "software" | "panic" | "int_wdt" | "task_wdt" | "other_wdt" | "deep_sleep" | "brownout" | "sdio" | "usb" | "jtag" | "efuse" | "power_glitch" | "cpu_lockup" | "unknown";
  uptime_s: number;
  guard_restarts_in_hour: number;
};

export type NodeControlResultDiagnosticsPackageBoot = {
  cause: "panic" | "task_watchdog" | "interrupt_watchdog" | "other_watchdog" | "brownout" | "power_glitch" | "cpu_lockup" | "out_of_memory" | "guard_missing_task" | "guard_low_memory" | "guard_dead_man" | "guard";
  reset_reason: "power_on" | "external" | "software" | "panic" | "int_wdt" | "task_wdt" | "other_wdt" | "deep_sleep" | "brownout" | "sdio" | "usb" | "jtag" | "efuse" | "power_glitch" | "cpu_lockup" | "unknown";
  uptime_before_s?: number;
  heap_internal_free?: number;
  heap_internal_largest?: number;
  coredump: boolean;
  deliberate: boolean;
  guard: boolean;
};

export type NodeControlResultDiagnosticsPackageMemoryGate = {
  closed: boolean;
  transitions: number;
  close_free: number;
  close_block: number;
  open_free: number;
  open_block: number;
};

export type NodeControlResultDiagnosticsPackageVersionsSensors = {
  name: string;
  version: string;
};

export type NodeControlResultDiagnosticsPackageVersions = {
  firmware: string;
  idf: string;
  board?: string;
  sensors: NodeControlResultDiagnosticsPackageVersionsSensors[];
};

export type NodeControlResultDiagnosticsPackageCoredumpSummary = {
  task: string;
  reason?: string;
  pc?: string;
  backtrace?: string[];
  app_sha256?: string;
};

export type NodeControlResultDiagnosticsPackageCoredump = {
  present: boolean;
  size?: number;
  summary?: NodeControlResultDiagnosticsPackageCoredumpSummary;
};

export type NodeControlResultDiagnosticsPackage = {
  detail: "package" | "log";
  heap?: NodeControlResultDiagnosticsPackageHeap;
  tasks?: NodeControlResultDiagnosticsPackageTasks[];
  resets?: NodeControlResultDiagnosticsPackageResets;
  boot?: NodeControlResultDiagnosticsPackageBoot;
  memory_gate?: NodeControlResultDiagnosticsPackageMemoryGate;
  versions?: NodeControlResultDiagnosticsPackageVersions;
  config?: Record<string, string>;
  coredump?: NodeControlResultDiagnosticsPackageCoredump;
  log: string;
  truncated: boolean;
};

export type NodeControlResultDiagnostics = {
  firmware: string;
  uptime_s: number;
  reset_reason: "power_on" | "external" | "software" | "panic" | "int_wdt" | "task_wdt" | "other_wdt" | "deep_sleep" | "brownout" | "sdio" | "usb" | "jtag" | "efuse" | "power_glitch" | "cpu_lockup" | "unknown";
  heap_free: number;
  heap_min: number;
  psram_free?: number;
  stack_min_free?: number;
  rssi?: number;
  mqtt_connected: boolean;
  state: "running" | "paused" | "standby";
  maintenance: boolean;
  package?: NodeControlResultDiagnosticsPackage;
};

export type NodeControlResult = {
  kind: "node_control_result";
  node_id: string;
  timestamp_ms: number;
  command_id: string;
  action: "arm" | "execute";
  operation: "restart" | "pause" | "resume" | "standby" | "identify" | "diagnostics" | "maintenance_on" | "maintenance_off";
  stage: "armed" | "restarting" | "applied" | "diagnostics" | "rejected";
  accepted: boolean;
  refusal: "none" | "not_armed" | "invalid_token" | "token_expired" | "rate_limited" | "already_restarting" | "already_in_state" | "busy_update" | "busy_upload" | "busy_slot_copy" | "busy_battery" | "unavailable";
  token?: string;
  token_ttl_s?: number;
  reason?: "requested_by_server";
  mode?: "now" | "rolling";
  restart_in_s?: number;
  uptime_s?: number;
  firmware?: string;
  requested_by?: string;
  state?: "running" | "paused" | "standby";
  maintenance?: boolean;
  until_s?: number;
  since_ms?: number;
  diagnostics?: NodeControlResultDiagnostics;
};

export type NodeMaintenance = {
  kind: "node_maintenance";
  node_id: string;
  timestamp_ms: number;
  active: boolean;
  reason: "restart" | "pause" | "standby" | "update" | "upload" | "operator";
  expected_s?: number;
  firmware: string;
  requested_by?: string;
};

export type RadarEvent = {
  kind: "radar_event";
  node_id: string;
  timestamp_ms: number;
  boot: number;
  seq: number;
  event: "zone_occupied" | "zone_clear" | "loiter" | "tripwire" | "path_violation" | "masking" | "masking_end" | "sensor_bluetooth_open" | "sensor_bluetooth_closed" | "wifi_jam" | "wifi_jam_end" | "bridge_opened" | "bridge_closed";
  name?: string;
  sensor_id?: number;
  track_id?: number;
  movement?: "still" | "walking" | "running";
  value?: number;
  count?: number;
  direction?: "in" | "out";
  from?: string;
  by?: string;
};

export type DiagnosticTokenRequest = {
  nodes: string[];
  ttl_s?: number;
  label?: string;
};

export type DiagnosticTokenCreated = {
  id: string;
  token: string;
  scope: "read_only";
  nodes: string[];
  label?: string;
  created_at: string;
  expires_at: string;
  created_by: string;
};

export type DiagnosticTokenInfo = {
  id: string;
  scope: "read_only";
  nodes: string[];
  label?: string;
  created_at: string;
  expires_at: string;
  created_by: string;
  status: "active" | "expired" | "revoked";
  revoked_at?: string;
  revoked_by?: string;
  uses: number;
  last_used_at?: string;
};

export type AlarmZone = {
  id: string;
  name?: string;
  kind: "instant" | "entry" | "interior" | "always";
  state: "normal" | "triggered" | "tamper" | "trouble";
  bypassed: boolean;
};

export type AlarmEvent = {
  ago_s: number;
  kind: "armed" | "exit_delay_started" | "entry_delay_started" | "alarm" | "siren_timed_out" | "disarmed" | "bad_pin" | "locked_out" | "zone_bypassed" | "siren_silenced";
  zone?: string;
};

export type Alarm = {
  kind: "alarm";
  node_id: string;
  timestamp_ms: number;
  phase: "disarmed" | "exit_delay" | "armed" | "entry_delay" | "alarm";
  mode: "disarmed" | "away" | "stay";
  siren: boolean;
  locked_out: boolean;
  commands_enabled: boolean;
  zones: AlarmZone[];
  open_zones: string[];
  events: AlarmEvent[];
  arm_profiles?: boolean;
  profile?: string;
  siren_loop?: "unknown" | "ok" | "open" | "short" | "unreadable";
  siren_fault?: boolean;
  seq?: number;
  sig?: string;
};

export type ArmProfileZone = {
  id: string;
  armed?: boolean;
  delay?: "instant" | "entry";
};

export type ArmProfile = {
  id: string;
  name: string;
  base: "away" | "stay";
  exit_delay_s?: number;
  entry_delay_s?: number;
  siren?: boolean;
  notify?: "urgent" | "normal";
  zones?: ArmProfileZone[];
};

export type AlarmCommand = {
  kind: "alarm_command";
  node_id: string;
  timestamp_ms: number;
  command_id: string;
  action: "arm" | "disarm" | "silence";
  mode?: "away" | "stay";
  force?: boolean;
  profile?: ArmProfile;
};

export type AlarmResult = {
  kind: "alarm_result";
  node_id: string;
  timestamp_ms: number;
  command_id: string;
  action: "arm" | "disarm" | "silence";
  accepted: boolean;
  refusal: "none" | "not_disarmed" | "zones_open" | "not_armed" | "bad_pin" | "locked_out";
  phase: "disarmed" | "exit_delay" | "armed" | "entry_delay" | "alarm";
};

export type ArmingModesModesAway = {
  entry?: string[];
  exit_delay_s?: number;
  entry_delay_s?: number;
};

export type ArmingModesModesHome = {
  defends?: string[];
  entry?: string[];
  exit_delay_s?: number;
  entry_delay_s?: number;
};

export type ArmingModesModesNight = {
  defends?: string[];
  entry?: string[];
  exit_delay_s?: number;
  entry_delay_s?: number;
};

export type ArmingModesModes = {
  away: ArmingModesModesAway;
  home: ArmingModesModesHome;
  night: ArmingModesModesNight;
};

export type ArmingModesSchedule = {
  mode: "away" | "home" | "night";
  days: number[];
  at: string;
};

export type ArmingModesPanelMapProfiles = {
  away?: string;
  home?: string;
  night?: string;
};

export type ArmingModesPanelMap = {
  profiles?: ArmingModesPanelMapProfiles;
  only?: string[];
};

export type ArmingModes = {
  modes: ArmingModesModes;
  schedule?: ArmingModesSchedule[];
  panel_map?: ArmingModesPanelMap;
};

export type AlarmZoneFeed = {
  zone: string;
  state: "normal" | "triggered" | "tamper";
  battery_low: boolean;
  seq?: number;
  sig?: string;
};

export type AlarmPolicy = {
  config_hash: boolean;
  zone_feed: boolean;
  zone_feed_signature: boolean;
  disarm_pin?: "never" | "if_set" | "always";
  nvs_encryption?: "secrets";
};

export type NodeHealthBoot = {
  cause: "panic" | "task_watchdog" | "interrupt_watchdog" | "other_watchdog" | "brownout" | "power_glitch" | "cpu_lockup" | "out_of_memory" | "guard_missing_task" | "guard_low_memory" | "guard_dead_man" | "guard";
  reset_reason: "power_on" | "external" | "software" | "panic" | "int_wdt" | "task_wdt" | "other_wdt" | "deep_sleep" | "brownout" | "sdio" | "usb" | "jtag" | "efuse" | "power_glitch" | "cpu_lockup" | "unknown";
  uptime_before_s?: number;
  heap_internal_free?: number;
  heap_internal_largest?: number;
  coredump: boolean;
  deliberate: boolean;
  guard: boolean;
};

export type NodeHealthMemoryGate = {
  closed: boolean;
  transitions: number;
  close_free: number;
  close_block: number;
  open_free: number;
  open_block: number;
};

export type NodeHealthCoredump = {
  present: boolean;
  size?: number;
};

export type NodeHealthConfigCheck = {
  snapshot?: "restored" | "failed";
  reverted?: "reapplied" | "failed";
};

export type NodeHealthSensors = {
  sensor_id: number;
  model: "ld2450" | "ld2461" | "ld2410" | "ld2412" | "ld2410s" | "mr24hpc1";
  state: "reporting" | "no_data" | "garbled" | "silent" | "bridge";
  firmware_known: boolean;
  firmware?: string;
  bluetooth: "unknown" | "open" | "closed" | "none";
  mac?: string;
  bluetooth_alert?: boolean;
  quirk?: "ld2412_bad_firmware" | "ld2412_unknown_firmware";
};

export type NodeHealthRadar = {
  perimeter_enabled: boolean;
  masked: boolean;
  wifi_jam: boolean;
  bridge_open: boolean;
  events_buffered: number;
  sensor_bluetooth_off: boolean;
};

export type NodeHealth = {
  kind: "node_health";
  node_id: string;
  timestamp_ms: number;
  family: "radar" | "solar" | "electrical" | "alarm" | "hmi";
  firmware: string;
  contract?: string;
  board?: string;
  uptime_s: number;
  reset_reason: "power_on" | "external" | "software" | "panic" | "int_wdt" | "task_wdt" | "other_wdt" | "deep_sleep" | "brownout" | "sdio" | "usb" | "jtag" | "efuse" | "power_glitch" | "cpu_lockup" | "unknown";
  heap_free: number;
  heap_min: number;
  heap_internal_free?: number;
  heap_internal_min?: number;
  heap_internal_largest?: number;
  psram_free?: number;
  link: "wifi" | "ethernet" | "none";
  link_up: boolean;
  rssi_dbm?: number;
  broker_reconnects: number;
  low_stack_tasks?: number;
  stack_min_free?: number;
  stack_min_task?: string;
  last_error?: string;
  control_state?: "running" | "paused" | "standby";
  control_since_ms?: number;
  control_by?: string;
  control_until_s?: number;
  maintenance?: boolean;
  maintenance_until_s?: number;
  boot?: NodeHealthBoot;
  memory_gate?: NodeHealthMemoryGate;
  coredump?: NodeHealthCoredump;
  config_check?: NodeHealthConfigCheck;
  sensors?: NodeHealthSensors[];
  radar?: NodeHealthRadar;
};

export type VoiceTurnMeta = {
  language: "en" | "es" | "de" | "fr" | "it" | "ja" | "zh" | "pt";
  encoding: "pcm_s16le";
  sample_rate: 16000;
  channels: 1;
  reply_audio?: "base64" | "binary" | "none";
};

export type VoiceTurnResult = {
  heard: string;
  reply: string;
  audio?: string;
  audio_omitted?: "too_large";
  challenge?: string;
};

export type ConnectionEvent = {
  id: number;
  at: string;
  type: "connection";
  action: "first_seen" | "login" | "login_failed" | "second_factor_failed" | "logout" | "session_ended" | "session_expired" | "panel_opened";
  client_kind: "studio" | "android" | "node" | "voice" | "other";
  client_id: string;
  user?: string;
  origin?: "local" | "remote";
  two_factor?: boolean;
  app_version?: string;
  subject?: string;
  ip?: string;
  agent?: string;
};

export type SystemEvent = {
  id: number;
  at: string;
  type: "system";
  category: "node" | "broker" | "settings" | "service" | "update" | "alarm" | "backup" | "batteries";
  action: "appeared" | "returned" | "disappeared" | "firmware_changed" | "connected" | "disconnected" | "created" | "changed" | "removed" | "started" | "stopped" | "restarted" | "checked" | "installed" | "rolled_back" | "armed" | "disarmed" | "silenced" | "acknowledged" | "arm_requested" | "disarm_requested" | "silence_requested" | "backup_made" | "backup_restored" | "battery_requested" | "battery_operation" | "control_requested" | "control_acknowledged" | "control_refused" | "control_applied" | "control_back" | "control_lost" | "maintenance_started" | "maintenance_ended" | "maintenance_expired" | "dirty_boot" | "sensor_bluetooth_open" | "sensor_bluetooth_closed" | "radar_event" | "diagnostic_token_issued" | "diagnostic_token_revoked" | "diagnostic_token_used" | "diagnostic_token_denied";
  subject?: string;
  by?: string;
  version?: string;
  previous_version?: string;
  profile?: string;
  outcome?: "allowed" | "denied" | "failed";
};

export type ConnectionClient = {
  id: string;
  kind: "studio" | "android" | "node" | "voice" | "other";
  user?: string;
  label?: string;
  app_version?: string;
  origin?: "local" | "remote";
  two_factor?: boolean;
  first_seen: string;
  last_seen: string;
  last_failure?: string;
  active_sessions: number;
  logins_ok: number;
  logins_failed: number;
  ip?: string;
  agent?: string;
};

export type DailySummaryBodyTotals = {
  events: number;
  alarms: number;
  serious_alarms: number;
  false_alarms: number;
};

export type DailySummaryBodySeriousAlarms = {
  t_s: number;
  code?: string;
  zone?: string;
  node?: string;
  sensor?: string;
  severity?: "info" | "low" | "medium" | "high" | "critical";
  watts?: number;
  value?: number;
  duration_s?: number;
  mean_w?: number;
  limit_w?: number;
};

export type DailySummaryBodyNodesLinkLost = {
  node: string;
  count: number;
  total_s: number;
};

export type DailySummaryBodyOutlierReadings = {
  t_s: number;
  node: string;
  sensor: string;
  value: number;
  median: number;
  score: number;
};

export type DailySummaryBodyConsumptionPeaks = {
  t_s: number;
  code?: string;
  zone?: string;
  node?: string;
  sensor?: string;
  severity?: "info" | "low" | "medium" | "high" | "critical";
  watts?: number;
  value?: number;
  duration_s?: number;
  mean_w?: number;
  limit_w?: number;
};

export type DailySummaryBodyConsumption = {
  samples: number;
  peaks: DailySummaryBodyConsumptionPeaks[];
};

export type DailySummaryBody = {
  schema: "armor-daily-summary/1";
  totals: DailySummaryBodyTotals;
  by_type: Record<string, number>;
  by_zone: Record<string, number>;
  by_hour: number[];
  serious_alarms?: DailySummaryBodySeriousAlarms[];
  nodes_link_lost?: DailySummaryBodyNodesLinkLost[];
  outlier_readings?: DailySummaryBodyOutlierReadings[];
  consumption?: DailySummaryBodyConsumption;
};

export type DailySummaryFindingSubject = {
  code?: string;
  zone?: string;
  node?: string;
};

export type DailySummaryFindingDetail = {
  hours?: number[];
  tolerance_min?: number;
  max_gap_s?: number;
  limit_s?: number;
  minimum?: number;
  window?: number;
  sigma?: number;
  min_ratio?: number;
};

export type DailySummaryFindingEvidence = {
  t_s: number;
  code?: string;
  zone?: string;
  node?: string;
  sensor?: string;
  severity?: "info" | "low" | "medium" | "high" | "critical";
  watts?: number;
  value?: number;
  duration_s?: number;
  mean_w?: number;
  limit_w?: number;
};

export type DailySummaryFinding = {
  kind: "hourly_repeat" | "intermittent_sensor" | "intermittent_link" | "recurrent_false_alarm" | "anomalous_consumption";
  subject: DailySummaryFindingSubject;
  count: number;
  detail: DailySummaryFindingDetail;
  evidence: DailySummaryFindingEvidence[];
};

export type DailySummary = {
  date: string;
  language: "en" | "es" | "de" | "fr" | "it" | "ja" | "zh" | "pt";
  summary: DailySummaryBody;
  findings: DailySummaryFinding[];
  text: string;
  ai_note?: string;
};

export type Heatmap = {
  schema: "armor.vision.heatmap/v1";
  camera_id: string;
  cols: number;
  rows: number;
  accepted_positions: number;
  rejected_positions: number;
  total: number;
  max: number;
  weights: number[][];
  normalized: number[][];
  contains_images: false;
};

export type NetworkInterface = {
  name: string;
  ip: string;
  cidr: string;
  gateway?: string;
  rx_bps?: number;
  tx_bps?: number;
};

export type NetworkProbe = {
  target: string;
  kind: "icmp" | "tcp" | "dns" | "http";
  ok: boolean;
  latency_ms?: number;
};

export type NetworkOutage = {
  started_ms: number;
  ended_ms: number;
  duration_s: number;
};

export type NetworkInternet = {
  state: "up" | "degraded" | "down" | "lan_down" | "unknown";
  since_ms?: number;
  gateway_ok?: boolean;
  latency_ms?: number;
  loss_percent?: number;
  probes?: NetworkProbe[];
  last_outage?: NetworkOutage;
  outages_24h?: number;
  downtime_24h_s?: number;
};

export type NetworkPort = {
  port: number;
  proto: "tcp" | "udp";
  service?: string;
  banner?: string;
};

export type NetworkDevice = {
  id: string;
  ip: string;
  mac?: string;
  randomized_mac?: boolean;
  vendor?: string;
  hostname?: string;
  kind?: "router" | "computer" | "phone" | "tv" | "printer" | "camera" | "iot" | "server" | "nas" | "network" | "unknown";
  os?: string;
  online: boolean;
  first_seen_ms: number;
  last_seen_ms: number;
  latency_ms?: number;
  ports?: NetworkPort[];
  services?: string[];
};

export type NetworkEvent = {
  id: string;
  kind: "new_device" | "device_online" | "device_offline" | "ip_changed" | "arp_conflict" | "port_opened" | "port_closed" | "internet_down" | "internet_up" | "gateway_down" | "gateway_up";
  at_ms: number;
  device_id?: string;
  port?: number;
  outage_s?: number;
  detail?: string;
};

export type NetworkScan = {
  last_ms: number;
  hosts: number;
  duration_ms?: number;
};

export type NetworkPublicDns = {
  name: string;
  addresses: string[];
  matches: boolean;
};

export type NetworkPublic = {
  ip: string;
  hostname?: string;
  city?: string;
  region?: string;
  country?: string;
  org?: string;
  timezone?: string;
  checked_ms: number;
  changed_ms?: number;
  dns?: NetworkPublicDns;
};

export type NetworkResults = {
  id: string;
  type: "scan_now" | "ping" | "traceroute" | "wake" | "ports" | "http" | "inspect";
  ok: boolean;
  finished_ms: number;
  device_id?: string;
  output?: string;
  ports?: NetworkPort[];
  latency_ms?: number;
};

export type Network = {
  kind: "network";
  node_id: string;
  contract?: number;
  timestamp_ms: number;
  interface: NetworkInterface;
  internet: NetworkInternet;
  devices: NetworkDevice[];
  events?: NetworkEvent[];
  scan?: NetworkScan;
  public?: NetworkPublic;
  results?: NetworkResults[];
};

export type AiObservationRegions = {
  x: number;
  y: number;
  w: number;
  h: number;
};

export type AiObservation = {
  camera_id: string;
  severity: "review" | "high";
  reasons: string[];
  profile: "daylight" | "low-light";
  motion: number;
  motion_ratio?: number;
  regions?: AiObservationRegions[];
  radar_tracks: number;
};

export type DeviceState = {
  on: boolean;
};

export type NetworkOrdersCommands = {
  id: string;
  type: "scan_now" | "ping" | "traceroute" | "wake" | "ports" | "http" | "inspect";
  device_id?: string;
  ip?: string;
  mac?: string;
  port?: number;
  auth_sealed?: string;
};

export type NetworkOrders = {
  accepted: true;
  commands: NetworkOrdersCommands[];
};

export type ServerAlert = {
  service: "armor-server";
  event: "alert.raised" | "alert.cleared" | "node.offline" | "node.stale" | "camera.offline" | "alarm.raised" | "alarm.escalated" | "automation.notify" | "login.remote" | "alert.test";
  at: string;
  mode: "armed" | "disarmed";
  node_id?: string;
  camera_id?: string;
  targets?: number;
  minutes?: number;
  alarm_id?: string;
  severity?: "critical" | "high" | "warning";
  code?: string;
  device_id?: string;
  solar_id?: string;
  electrical_id?: string;
  alarm_node_id?: string;
  network_id?: string;
  silent?: true;
  automation?: string;
  login_user?: string;
  login_from?: string;
  login_country?: string;
  login_country_new?: true;
};

export type VisionEventVectors = {
  track_id: number;
  dx: number;
  dy: number;
  speed: number;
};

export type VisionEvent = {
  schema: "armor.vision.event/v1" | "armor.vision.event/v2";
  type: "alert" | "detection";
  camera_id: string;
  zone_id: string;
  zone_name: string;
  track_id: number;
  label: string;
  confidence: number;
  box: number[];
  timestamp: number;
  timestamp_ms: number;
  authorizes_action: false;
  radar_tracks?: number;
  vectors?: VisionEventVectors[];
};

export const MAX_TARGETS = 15;
export const MAX_LUX = 200000;
export const NODE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const COMMANDS = ["calibrate", "set_thresholds", "restart"] as const;
