/**
 * Body of a container healthcheck script: requests http://127.0.0.1:<PORT><path> and sets the exit
 * code to 0 when `accept(status)` holds, otherwise 1 (including timeouts and refused connections).
 */
export async function runHttpHealthcheck(
  path: string,
  accept: (status: number) => boolean,
  port: string = process.env.PORT ?? '8080',
): Promise<void> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      signal: AbortSignal.timeout(3_000),
    });
    process.exitCode = accept(res.status) ? 0 : 1;
  } catch {
    process.exitCode = 1;
  }
}
