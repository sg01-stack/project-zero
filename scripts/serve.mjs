import { fileURLToPath } from 'node:url';
import { createApplicationServer } from '../server/app.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const server = createApplicationServer({ root });
const port = Number(process.env.PORT || 8000);
server.listen(port, '127.0.0.1', () => console.log(`EchoSphere listening on port ${port}.`));
