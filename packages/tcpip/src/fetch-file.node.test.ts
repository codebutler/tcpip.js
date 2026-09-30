import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { fetchFile } from './fetch-file.js';

const emptyWasm = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0);
let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'tcpip-fetch-file-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('native finite WASM file loading', () => {
  test('reads a file URL into a WASM response with the exact bytes', async () => {
    const file = join(directory, 'module.wasm');
    await writeFile(file, emptyWasm);
    const response = await fetchFile(pathToFileURL(file), 'application/wasm');
    expect(response.headers.get('content-type')).toBe('application/wasm');
    expect(new Uint8Array(await response.clone().arrayBuffer())).toEqual(
      emptyWasm
    );
    await expect(
      WebAssembly.compileStreaming(response)
    ).resolves.toBeInstanceOf(WebAssembly.Module);
  });

  test('rejects missing files through the returned promise', async () => {
    await expect(
      fetchFile(
        pathToFileURL(join(directory, 'missing.wasm')),
        'application/wasm'
      )
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('rejects unreadable file targets through the returned promise', async () => {
    await expect(
      fetchFile(pathToFileURL(directory), 'application/wasm')
    ).rejects.toMatchObject({ code: 'EISDIR' });
  });

  test('preserves corrupt bytes for the WASM compiler to reject', async () => {
    const file = join(directory, 'corrupt.wasm');
    await writeFile(file, Uint8Array.of(1, 2, 3, 4));
    const response = await fetchFile(file, 'application/wasm');
    await expect(WebAssembly.compileStreaming(response)).rejects.toBeInstanceOf(
      WebAssembly.CompileError
    );
  });
});
