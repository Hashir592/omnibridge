import { createLogger } from '@omnibridge/logger';
import { buildMockServer } from './server.ts';

const app = buildMockServer(createLogger({ service: 'provider-mocks', version: '0.0.0-dev' }));
await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? '8080') });

process.once('SIGTERM', () => void app.close().then(() => process.exit(0)));
