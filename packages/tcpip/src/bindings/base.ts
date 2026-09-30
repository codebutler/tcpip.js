import { NetworkError } from '../network-error.js';
import { UniquePointer } from '../util.js';
import type {
  CommonExports,
  Pointer,
  SysExports,
  WasiExports,
} from './types.js';

export abstract class Bindings<Imports, Exports> {
  #exports?: Exports & CommonExports & WasiExports & SysExports;

  protected disposedError?: Error;

  protected assertActive() {
    if (this.disposedError) throw this.disposedError;
  }

  // A stack owns the whole WASM instance. Terminal disposal releases its
  // exports rather than waiting for TCP FIN/ACK or removing individual PCBs.
  dispose(
    error: Error = new NetworkError('ENETDOWN', 'network stack disposed')
  ) {
    this.disposedError ??= error;
    this.#exports = undefined;
  }

  abstract imports: Imports;

  get exports(): Exports & CommonExports & WasiExports & SysExports {
    this.assertActive();
    if (!this.#exports) {
      throw new Error('exports were not registered');
    }
    return this.#exports;
  }

  /**
   * Register the exports object from the wasm module.
   */
  register(exports: Exports & CommonExports & WasiExports & SysExports) {
    this.assertActive();
    this.#exports = exports;
  }

  /**
   * Allocates a region of wasm memory and returns a `UniquePointer` to the start.
   *
   * `UniquePointer` will automatically free the memory when it is disposed.
   * It is intended to be used with the `using` statement which will automatically
   * dispose of the pointer when the current scope ends.
   */
  smartMalloc(size: number) {
    return new UniquePointer(this.exports.malloc(size), this.exports.free);
  }

  /**
   * Copies a Uint8Array to a newly allocated region of wasm memory.
   *
   * @returns A pointer to the start of the copied data.
   */
  copyToMemory(data: Uint8Array) {
    const length = data.length;
    const pointer = this.smartMalloc(length);

    const memoryView = new Uint8Array(
      this.exports.memory.buffer,
      pointer.valueOf(),
      length
    );

    memoryView.set(data);

    return pointer;
  }

  /**
   * Copies a region of wasm memory to a new Uint8Array.
   *
   * @returns A new Uint8Array containing the copied data.
   */
  copyFromMemory(ptr: Pointer | number, length: number): Uint8Array {
    const buffer = this.exports.memory.buffer.slice(
      Number(ptr),
      Number(ptr) + length
    );
    return new Uint8Array(buffer);
  }

  /**
   * Creates a Uint8Array view over a region of wasm memory.
   */
  viewFromMemory(ptr: Pointer | number, length: number): Uint8Array {
    return new Uint8Array(this.exports.memory.buffer, Number(ptr), length);
  }
}
