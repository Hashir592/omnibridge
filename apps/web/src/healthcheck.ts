import { runHttpHealthcheck } from '@omnibridge/core';

// The process answers HTTP. Database state is in the body (503 = degraded) and does not fail the
// container, so a database outage shows as "degraded" instead of a restart loop.
await runHttpHealthcheck('/healthz', (status) => status === 200 || status === 503);
