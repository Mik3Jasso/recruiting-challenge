/**
 * Read-only reconciliation of orders data vs live API vs dashboard logic.
 * Usage: DB_PATH=data/audit.db BASE=http://localhost:3901 npx tsx audit/reconcile.ts
 * Opens the DB readonly; only issues GET requests.
 */
import Database from 'better-sqlite3';

const DB_PATH = process.env.DB_PATH ?? 'data/audit.db';
const BASE = process.env.BASE ?? 'http://localhost:3901';
if (/dashboard\.db$/.test(DB_PATH)) throw new Error('refusing to touch dashboard.db');
const db = new Database(DB_PATH, { readonly: true });

type Row = { id: string; merchant_id: string; customer_email: string; total_amount: number; type: string; status: string; created_at: string };
let discrepancies = 0;
function cmp(label: string, expected: unknown, actual: unknown, note = '') {
  const ok = JSON.stringify(expected) === JSON.stringify(actual);
  if (!ok) discrepancies++;
  console.log(`  ${ok ? 'OK  ' : 'DIFF'} ${label}: independent=${JSON.stringify(expected)} shown=${JSON.stringify(actual)} ${ok ? '' : note}`);
}
async function api(path: string, m: string) {
  const r = await fetch(BASE + path, { headers: { 'X-Merchant-Id': m } });
  return (await r.json()) as any;
}
const money = (c: number) => (c / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const merchants = db.prepare('SELECT id FROM merchants ORDER BY id').all() as { id: string }[];
console.log(`DB=${DB_PATH} BASE=${BASE}`);
console.log('Global: orders=', (db.prepare('SELECT COUNT(*) n FROM orders').get() as any).n,
  'by type/status:', JSON.stringify(db.prepare('SELECT merchant_id,type,status,COUNT(*) n,SUM(total_amount) s FROM orders GROUP BY 1,2,3').all()));

for (const { id: m } of merchants) {
  console.log(`\n=== ${m} ===`);
  const rows = db.prepare('SELECT * FROM orders WHERE merchant_id=?').all(m) as Row[];
  const sales = rows.filter((r) => r.type === 'sale');
  const refunds = rows.filter((r) => r.type === 'refund');
  const completed = rows.filter((r) => r.status === 'completed');
  const sum = (a: Row[]) => a.reduce((s, r) => s + r.total_amount, 0);
  const gross = sum(sales), ref = sum(refunds), net = gross - ref;
  console.log(`  rows=${rows.length} sales=${sales.length} refunds=${refunds.length} statuses=${JSON.stringify([...new Set(rows.map((r) => r.status))])} completed=${completed.length}`);
  console.log(`  gross sales=${gross} (${money(gross)}) refunds=${ref} (${money(ref)}) NET=${net} (${money(net)}) naive SUM(all)=${sum(rows)}`);
  const nonPositive = rows.filter((r) => !(r.total_amount > 0)).length;
  const badType = rows.filter((r) => !['sale', 'refund'].includes(r.type)).length;
  console.log(`  non-positive amounts=${nonPositive} unknown types=${badType} refunds stored as positive=${refunds.every((r) => r.total_amount > 0)}`);

  // /api/metrics/summary
  const s = await api('/api/metrics/summary', m);
  console.log('  -- /api/metrics/summary', JSON.stringify(s));
  cmp('total_orders vs sale count', sales.length, s.total_orders, '(API counts refund rows as orders)');
  cmp('unique_customers (sales only)', new Set(sales.map((r) => r.customer_email)).size, s.unique_customers);
  cmp('avg_order_value_cents vs avg of sales', Math.round(gross / (sales.length || 1)), s.avg_order_value_cents, '(avg includes refunds)');

  // /api/revenue full range. Use wide bounds; also bounds that include "today" entirely.
  const rev = await api('/api/revenue?from=1970-01-01&to=9999-12-31', m);
  console.log('  -- /api/revenue full range', JSON.stringify(rev));
  cmp('revenue_cents vs NET', net, rev.revenue_cents, `(delta ${rev.revenue_cents - net}; = 2*refunds ${2 * ref}? ${rev.revenue_cents - net === 2 * ref})`);
  cmp('revenue_cents vs gross sales', gross, rev.revenue_cents);

  // /api/orders large limit
  const o = await api('/api/orders?limit=100000', m);
  const list: Row[] = o.orders;
  cmp('orders list length', rows.length, list.length);
  cmp('orders list sum(all rows)', sum(rows), list.reduce((a, r) => a + r.total_amount, 0));
  const def = await api('/api/orders', m);
  cmp('default list length (limit 100)', rows.length, def.orders.length, '(truncated at 100)');

  // dashboard JS emulation
  console.log('  -- dashboard emulation (public/app.js)');
  const now = new Date();
  const thirtyAgo = new Date(now.getTime() - 30 * 864e5);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const from = iso(thirtyAgo), to = iso(now);
  const dash = await api(`/api/revenue?from=${from}&to=${to}`, m);
  const in30 = rows.filter((r) => r.created_at >= from && r.created_at < to);
  const in30Inclusive = rows.filter((r) => r.created_at >= from && r.created_at < to + 'T99');
  const net30 = (a: Row[]) => sum(a.filter((r) => r.type === 'sale')) - sum(a.filter((r) => r.type === 'refund'));
  console.log(`  window from=${from} to=${to}: rows(excl to-day)=${in30.length} rows(incl to-day)=${in30Inclusive.length}`);
  cmp('Revenue(30d) card vs NET incl. today', net30(in30Inclusive), dash.revenue_cents, `(card shows ${money(dash.revenue_cents)}; net30 excl today=${net30(in30)}, naive-sum excl today=${sum(in30)})`);
  cmp('Total orders card vs sale count', sales.length, s.total_orders);
  cmp('Avg order card', money(Math.round(gross / (sales.length || 1))), money(s.avg_order_value_cents));
  const tbl = (await api('/api/orders?limit=10', m)).orders as Row[];
  console.log(`  recent table shows ${tbl.length} of ${rows.length} rows (client display only; refunds shown as positive amounts: ${tbl.filter((r) => r.type === 'refund').map((r) => money(r.total_amount)).join(', ') || 'none in top 10'})`);

  // top customers
  const tc = (await api('/api/metrics/top-customers?limit=100', m)).customers as any[];
  const tcSales: Record<string, number> = {};
  for (const r of sales) tcSales[r.customer_email] = (tcSales[r.customer_email] ?? 0) + r.total_amount;
  const tcNet: Record<string, number> = {};
  for (const r of rows) tcNet[r.customer_email] = (tcNet[r.customer_email] ?? 0) + (r.type === 'sale' ? 1 : -1) * r.total_amount;
  cmp('top-customers sum(total_spent) vs NET', net, tc.reduce((a, c) => a + c.total_spent, 0));
  cmp('top-customers sum(order_count) vs sales', sales.length, tc.reduce((a, c) => a + c.order_count, 0));
  void tcSales; void tcNet;
}

// cross-tenant & input probes (GET only)
console.log('\n=== cross-tenant probe (GET) ===');
const a = db.prepare("SELECT id FROM orders WHERE merchant_id='m_acme' LIMIT 1").get() as { id: string };
const x = await fetch(`${BASE}/api/orders/${a.id}`, { headers: { 'X-Merchant-Id': 'm_bistro' } });
console.log(`  bistro reads acme order ${a.id}: HTTP ${x.status}`);
const x2 = await fetch(`${BASE}/api/orders/${a.id}`, { headers: { 'X-Merchant-Id': 'nonexistent_merchant' } });
console.log(`  unknown merchant reads acme order: HTTP ${x2.status}`);
for (const q of ['limit=abc', 'limit=-1', 'limit=0', 'limit=1.5', 'limit=1e9', 'limit=']) {
  const r = await fetch(`${BASE}/api/orders?${q}`, { headers: { 'X-Merchant-Id': 'm_acme' } });
  const j = (await r.json()) as any;
  console.log(`  GET /api/orders?${q} -> HTTP ${r.status} rows=${j.orders?.length ?? JSON.stringify(j)}`);
}
{
  const exp = (db.prepare("SELECT COUNT(*) n FROM orders WHERE merchant_id='m_acme' AND created_at>='2026-08-01'").get() as any).n;
  const r1 = (await (await fetch(`${BASE}/api/orders?from=2026-08-01&to=2026-12-31&limit=1000`, { headers: { 'X-Merchant-Id': 'm_acme' } })).json()) as any;
  console.log(`  date range sanity: from=2026-08-01 to=2026-12-31 rows=${r1.orders.length} (DB rows>=from: ${exp})`);
  const only = (await (await fetch(`${BASE}/api/orders?from=2026-10-01&limit=1000`, { headers: { 'X-Merchant-Id': 'm_acme' } })).json()) as any;
  const all = db.prepare("SELECT COUNT(*) n FROM orders WHERE merchant_id='m_acme'").get() as any;
  console.log(`  'from' alone ignored: rows=${only.orders.length} == all ${all.n}? ${only.orders.length === all.n}`);
  const day = db.prepare("SELECT substr(created_at,1,10) d, COUNT(*) n FROM orders WHERE merchant_id='m_acme' GROUP BY d ORDER BY d DESC LIMIT 1").get() as any;
  const sameDay = (await (await fetch(`${BASE}/api/revenue?from=${day.d}&to=${day.d}`, { headers: { 'X-Merchant-Id': 'm_acme' } })).json()) as any;
  console.log(`  boundary: busiest-latest day ${day.d} (${day.n} acme rows): revenue?from=to=${day.d} -> ${sameDay.revenue_cents} (always 0, empty window)`);
  const nextDay = new Date(Date.parse(day.d) + 864e5).toISOString().slice(0, 10);
  const dayRev = (await (await fetch(`${BASE}/api/revenue?from=${day.d}&to=${nextDay}`, { headers: { 'X-Merchant-Id': 'm_acme' } })).json()) as any;
  const dayNaive = (db.prepare("SELECT COALESCE(SUM(total_amount),0) s FROM orders WHERE merchant_id='m_acme' AND substr(created_at,1,10)=?").get(day.d) as any).s;
  console.log(`  boundary: from=${day.d} to=${nextDay} -> ${dayRev.revenue_cents}; naive sum for that day=${dayNaive}`);
}
console.log(`\nTOTAL DISCREPANCIES: ${discrepancies}`);
