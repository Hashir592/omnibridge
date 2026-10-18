import { runHttpHealthcheck } from '@omnibridge/core';

// The process answers HTTP. db-pii state is in the body (503 = degraded) and does not fail the
// container.
await runHttpHealthcheck('/healthz', (status) => status === 200 || status === 503);
