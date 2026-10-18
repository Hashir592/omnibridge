import { runHttpHealthcheck } from '@omnibridge/core';

await runHttpHealthcheck('/_mock/health', (status) => status === 200);
