import assert from 'node:assert/strict';
import { parseTSV } from '../orderReportParser.js';

const parsed = parseTSV('\uFEFFOrder ID\tSKU\r\n123\tABC\r\n');
assert.deepEqual(parsed.rows, ['123\tABC']);
assert.deepEqual(parseTSV('Order ID\tSKU\n').rows, []);

console.log('order report parser tests passed');
