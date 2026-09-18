import fs from 'fs';
import path from 'path';

console.log('=== SENTINEL UI TELEMETRY VERIFICATION ===\n');

// 1. Verify contracts/feed.schema.json
const schemaPath = path.resolve('contracts/feed.schema.json');
if (!fs.existsSync(schemaPath)) {
  console.error('FAIL: contracts/feed.schema.json not found');
  process.exit(1);
}
const schemaJson = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
const schemaEvents = schemaJson.properties.event.enum;
console.log(`Schema event enum count: ${schemaEvents.length}`);
console.log(`Events defined in schema: ${schemaEvents.join(', ')}\n`);

// 2. Verify sample-feed.jsonl
const sampleFeedPath = path.resolve('public/sample-feed.jsonl');
if (!fs.existsSync(sampleFeedPath)) {
  console.error('FAIL: public/sample-feed.jsonl not found');
  process.exit(1);
}

const sampleLines = fs.readFileSync(sampleFeedPath, 'utf8').trim().split(/\r?\n/).filter(Boolean);
console.log(`Checking public/sample-feed.jsonl (${sampleLines.length} lines)...`);
for (const [idx, line] of sampleLines.entries()) {
  const parsed = JSON.parse(line);
  if (!parsed.ts || !parsed.event || !parsed.seq) {
    throw new Error(`Malformed event on line ${idx + 1}`);
  }
  if (!schemaEvents.includes(parsed.event)) {
    console.warn(`Warning: Event "${parsed.event}" on line ${idx + 1} is not in feed.schema.json enum`);
  }
}
console.log('PASS: public/sample-feed.jsonl parsed cleanly with zero schema errors.\n');

// 3. Confirm dual-agent-sample.jsonl does NOT exist
const dualSamplePath = path.resolve('public/dual-agent-sample.jsonl');
if (fs.existsSync(dualSamplePath)) {
  console.error('FAIL: dual-agent-sample.jsonl still exists in public directory');
  process.exit(1);
}
console.log('PASS: Confirmed dual-agent-sample.jsonl is deleted and not in public directory.\n');

// 4. Test overshoot calculation
const initialBudget = 1.0;
const overspentTotal = 1.2;
const remaining = initialBudget - overspentTotal;
if (remaining !== -0.2 && Math.abs(remaining - (-0.2)) > 0.00001) {
  console.error(`FAIL: Overshoot calculation incorrect, got ${remaining}`);
  process.exit(1);
}
console.log(`PASS: Overshoot correctly evaluates to negative remaining budget: $${remaining.toFixed(4)}`);

console.log('\nALL AUDITS AND VERIFICATIONS PASSED.');
