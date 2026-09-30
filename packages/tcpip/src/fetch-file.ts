const IN_NODE =
  typeof process === 'object' &&
  typeof process.versions === 'object' &&
  typeof process.versions.node === 'string';

/**
 * Fetches a file from the network or filesystem
 * depending on the environment.
 */
export async function fetchFile(input: string | URL, type: string) {
  if (IN_NODE) {
    return fetchFileNode(input, type);
  }
  return fetch(input);
}

async function fetchFileNode(input: string | URL, type: string) {
  const fs = await import('node:fs');
  // The finite WASM asset does not need a Node-to-Web stream adapter.
  // Browser-target bundles can substitute node:stream with a browser shim,
  // even though this branch executes only in a native host.
  const bytes = await fs.promises.readFile(input);
  return new Response(bytes, { headers: { 'Content-Type': type } });
}
