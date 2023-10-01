import { signToken } from '../src/auth.js';

const [id = 'cus_2', role = 'CUSTOMER'] = process.argv.slice(2);
if (role !== 'CUSTOMER' && role !== 'ADMIN') throw new Error('role must be CUSTOMER or ADMIN');
console.log(`{ "Authorization": "Bearer ${await signToken({ id, role }, '8h')}" }`);
