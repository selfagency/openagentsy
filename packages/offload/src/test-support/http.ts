import { createServer } from 'node:http';

/** One request the stub server received. */
export interface RecordedRequest {
  method: string;
  path: string;
  body: string;
}

/** What the stub server answers with. */
export interface StubResponse {
  status?: number;
  body: string;
}

export interface StubServer {
  /** The base URL the backend under test should point at. */
  baseUrl: string;
  /** Every request the server received, in order. */
  requests: RecordedRequest[];
  close(): void;
}

/**
 * A stub HTTP server on a random loopback port. The router talks to it over
 * a real socket, so the request the server sees is the request a local
 * backend would see - a mock would only assert what the mock was told.
 */
export async function startStubServer(
  respond: (request: RecordedRequest) => StubResponse | Promise<StubResponse>,
): Promise<StubServer> {
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    res.on('error', () => undefined);
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const request: RecordedRequest = {
        method: req.method ?? 'GET',
        path: req.url ?? '/',
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(request);
      void Promise.resolve(respond(request)).then((response) => {
        res.writeHead(response.status ?? 200, { 'content-type': 'application/json' });
        res.end(response.body);
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () => {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      server.close();
    },
  };
}
