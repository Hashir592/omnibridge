import { createServer, type Server } from 'node:http';
import type { Registry } from 'prom-client';

/**
 * Serves GET /metrics for the internal scraper (ADR-017). The port is never published: it is
 * reachable only on the worker's own Docker networks.
 */
export function startMetricsServer(registry: Registry, port: number): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/metrics') {
      res.writeHead(404).end();
      return;
    }
    registry
      .metrics()
      .then((body) => {
        res.writeHead(200, { 'content-type': registry.contentType }).end(body);
      })
      .catch(() => {
        res.writeHead(500).end();
      });
  });
  return new Promise((resolve) => {
    server.listen(port, '0.0.0.0', () => {
      resolve(server);
    });
  });
}
