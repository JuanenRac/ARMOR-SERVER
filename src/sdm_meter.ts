/**
 * The Eastron SDM120 and SDM230 energy meters, as the electrical nodes will read them over Modbus RTU, and a simulated one to test with. Both meters answer the input registers
 * as 32-bit floats (two 16-bit registers, high word first); the active power is signed (positive when the house draws, negative when it feeds the grid), which is what makes
 * them the meter to put on the connection to the grid for the balance of the house. This is the decoder (registers in, a channel of the electrical contract out) and the simulation
 * (a meter whose power and energy are set by the test and whose answer is the bytes a real one would send); the driver in the node's firmware reads the same addresses.
 * Not yet proved on a real meter.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
export const SDM_REGISTERS = {
  voltage_v: 0x0000, current_a: 0x0006, active_power_w: 0x000C, apparent_power_va: 0x0012, reactive_power_var: 0x0018, power_factor: 0x001E, frequency_hz: 0x0046,
  import_kwh: 0x0048, export_kwh: 0x004A,
} as const;
export type SdmKey = keyof typeof SDM_REGISTERS;
export type SdmReading = Record<SdmKey, number>;

/** Two registers (high word first) as a float. */
export const floatOf = (high: number, low: number): number => {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt16BE(high & 0xffff, 0);
  buffer.writeUInt16BE(low & 0xffff, 2);
  return buffer.readFloatBE(0);
};
export const registersOf = (value: number): [number, number] => {
  const buffer = Buffer.alloc(4);
  buffer.writeFloatBE(value, 0);
  return [buffer.readUInt16BE(0), buffer.readUInt16BE(2)];
};

/** The reading in a block of input registers that starts at `start` (one read of 0x0000 to 0x004B covers all of them). Throws when the block does not reach a register or holds a number that is not one. */
export function decodeSdm(registers: readonly number[], start = 0): SdmReading {
  const out = {} as SdmReading;
  for (const [key, address] of Object.entries(SDM_REGISTERS) as Array<[SdmKey, number]>) {
    const at = address - start;
    if (at < 0 || at + 1 >= registers.length) throw new Error(`the block does not reach ${key}`);
    const value = floatOf(registers[at], registers[at + 1]);
    if (!Number.isFinite(value)) throw new Error(`${key} is not a number`);
    out[key] = value;
  }
  return out;
}

/** The channel of the electrical contract for the connection to the grid: the power is signed, the energy is what was imported. */
export function sdmChannel(reading: SdmReading, id = "grid"): { id: string; domain: "ac"; voltage_v: number; current_a: number; power_w: number; energy_kwh: number; frequency_hz: number; power_factor: number } {
  const round = (value: number, digits: number): number => Math.round(value * 10 ** digits) / 10 ** digits;
  return { id, domain: "ac", voltage_v: round(reading.voltage_v, 1), current_a: round(reading.current_a, 3), power_w: round(reading.active_power_w, 1), energy_kwh: round(reading.import_kwh, 2), frequency_hz: round(reading.frequency_hz, 2), power_factor: round(reading.power_factor, 3) };
}

/** A meter that does not exist: set its power and it keeps its own energy counters, and answers as the registers a real one would. */
export class SimulatedSdm {
  voltage = 230;
  frequency = 50;
  powerFactor = 0.98;
  importKwh = 1234.5;
  exportKwh = 56.7;
  #power = 0;

  /** Sets the power in watts (negative: feeding the grid). */
  setPower(watts: number): void { this.#power = watts; }

  /** Lets `hours` go by: the counters follow the power. */
  advance(hours: number): void {
    if (this.#power >= 0) this.importKwh += (this.#power * hours) / 1000;
    else this.exportKwh += (-this.#power * hours) / 1000;
  }

  /** The block of registers from 0x0000 to 0x004B, as a read of the input registers would give it. */
  registers(): number[] {
    const block = new Array<number>(0x4c).fill(0);
    const put = (address: number, value: number): void => { const [high, low] = registersOf(value); block[address] = high; block[address + 1] = low; };
    const apparent = Math.abs(this.#power) / this.powerFactor;
    put(SDM_REGISTERS.voltage_v, this.voltage);
    put(SDM_REGISTERS.current_a, apparent / this.voltage);
    put(SDM_REGISTERS.active_power_w, this.#power);
    put(SDM_REGISTERS.apparent_power_va, apparent);
    put(SDM_REGISTERS.reactive_power_var, Math.sqrt(Math.max(0, apparent ** 2 - this.#power ** 2)));
    put(SDM_REGISTERS.power_factor, this.#power < 0 ? -this.powerFactor : this.powerFactor);
    put(SDM_REGISTERS.frequency_hz, this.frequency);
    put(SDM_REGISTERS.import_kwh, this.importKwh);
    put(SDM_REGISTERS.export_kwh, this.exportKwh);
    return block;
  }
}
