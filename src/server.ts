import { createServer } from 'node:http';
import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 4000);
const { yoga } = createApp();
createServer(yoga).listen(port, () => {
  console.log(`GraphQL gateway: http://localhost:${port}/graphql (GraphiQL in the browser)`);
  console.log('Get a token: npm run token -- cus_2 CUSTOMER   (cus_1 is an ADMIN)');
});
