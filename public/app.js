const select = document.getElementById('merchant-select');
const totalOrdersEl = document.getElementById('total-orders');
const uniqueCustomersEl = document.getElementById('unique-customers');
const avgOrderEl = document.getElementById('avg-order');
const revenue30dEl = document.getElementById('revenue-30d');
const ordersTbody = document.getElementById('orders-tbody');

function api(path) {
  return fetch(path, { headers: { 'X-Merchant-Id': select.value } }).then((r) => r.json());
}

function money(cents) {
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- orders search

const filtersForm = document.getElementById('orders-filters');
const dateInput = document.getElementById('filter-date');
const emailInput = document.getElementById('filter-email');
const typeSelect = document.getElementById('filter-type');
const amountInput = document.getElementById('filter-amount');
const clearBtn = document.getElementById('clear-btn');
const filterErrorEl = document.getElementById('filter-error');
const ordersEmptyEl = document.getElementById('orders-empty');
const ordersErrorEl = document.getElementById('orders-error');
const ordersStatusEl = document.getElementById('orders-status');
const ordersTable = document.getElementById('orders-table');
const pagerEl = document.getElementById('pager');

const AMOUNT_RE = /^\d+(\.\d{1,2})?$/;

// Filters currently applied to the table (set on Search, not while typing) and the current page.
let appliedFilters = {};
let currentPage = 1;
let loadSeq = 0; // ignores responses that arrive after a newer request

dateInput.max = isoDate(new Date()); // UTC "today": future days cannot be picked

function readFilters() {
  return {
    date: dateInput.value,
    email: emailInput.value.trim(),
    type: typeSelect.value,
    amount: amountInput.value.trim(),
  };
}

/** Returns a friendly message for the first invalid filter, or '' when all are fine. */
function validateFilters(f) {
  if (f.date && f.date > isoDate(new Date())) return 'Pick a date that is not in the future.';
  if (f.amount && (!AMOUNT_RE.test(f.amount) || Number(f.amount) <= 0)) {
    return 'Enter the amount in dollars, like 12 or 12.50 (up to 2 decimals).';
  }
  return '';
}

function buildQuery(filters, page) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value) params.set(key, value);
  }
  params.set('page', String(page));
  return params.toString();
}

function utcDay(createdAt) {
  // created_at is stored in UTC ("YYYY-MM-DDT..." or "YYYY-MM-DD HH:MM:SS"); the first 10 chars are the UTC day.
  return String(createdAt).slice(0, 10);
}

function cell(text, className) {
  const td = document.createElement('td');
  td.textContent = text;
  if (className) td.className = className;
  return td;
}

function renderRows(orders) {
  ordersTbody.replaceChildren(
    ...orders.map((o) => {
      const tr = document.createElement('tr');
      tr.append(cell(utcDay(o.created_at)), cell(o.customer_email), cell(o.type), cell(money(o.total_amount), 'num'));
      return tr;
    }),
  );
}

/** Page numbers to show: first, last, and a window around the current page; null = ellipsis. */
function pageItems(current, totalPages) {
  const wanted = new Set([1, totalPages, current - 1, current, current + 1]);
  const pages = [...wanted].filter((p) => p >= 1 && p <= totalPages).sort((a, b) => a - b);
  const items = [];
  pages.forEach((p, i) => {
    if (i > 0 && p - pages[i - 1] > 1) items.push(null);
    items.push(p);
  });
  return items;
}

function pagerButton(label, onClick, { disabled = false, current = false, ariaLabel } = {}) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.disabled = disabled;
  if (ariaLabel) b.setAttribute('aria-label', ariaLabel);
  if (current) b.setAttribute('aria-current', 'page');
  b.addEventListener('click', onClick);
  return b;
}

function renderPager(page, totalPages) {
  if (totalPages < 1) {
    pagerEl.replaceChildren();
    return;
  }
  const nodes = [pagerButton('Prev', () => goToPage(page - 1), { disabled: page <= 1, ariaLabel: 'Previous page' })];
  for (const item of pageItems(page, totalPages)) {
    if (item === null) {
      const gap = document.createElement('span');
      gap.className = 'ellipsis';
      gap.textContent = '…';
      gap.setAttribute('aria-hidden', 'true');
      nodes.push(gap);
    } else {
      nodes.push(pagerButton(String(item), () => goToPage(item), { current: item === page, ariaLabel: `Page ${item}` }));
    }
  }
  nodes.push(pagerButton('Next', () => goToPage(page + 1), { disabled: page >= totalPages, ariaLabel: 'Next page' }));
  pagerEl.replaceChildren(...nodes);
}

function statusText(page, pageSize, shown, total) {
  if (total === 0) return 'Showing 0 of 0';
  const start = (page - 1) * pageSize + 1;
  return `Showing ${start.toLocaleString('en-US')}–${(start + shown - 1).toLocaleString('en-US')} of ${total.toLocaleString('en-US')}`;
}

function showLoadError(message) {
  ordersErrorEl.textContent = message;
  ordersErrorEl.hidden = false;
  ordersTbody.replaceChildren();
  ordersEmptyEl.hidden = true;
  pagerEl.replaceChildren();
  ordersStatusEl.textContent = '';
}

async function loadOrders() {
  const seq = ++loadSeq;
  ordersTable.setAttribute('aria-busy', 'true');
  try {
    const res = await fetch(`/api/orders/search?${buildQuery(appliedFilters, currentPage)}`, {
      headers: { 'X-Merchant-Id': select.value },
    });
    const body = await res.json();
    if (seq !== loadSeq) return;
    if (!res.ok) {
      showLoadError(`Could not load orders: ${typeof body.detail === 'string' ? body.detail : 'request failed'}.`);
      return;
    }
    if (body.orders.length === 0 && body.total > 0 && currentPage > body.total_pages) {
      currentPage = body.total_pages; // data shrank under us; show the last page instead
      await loadOrders();
      return;
    }
    ordersErrorEl.hidden = true;
    currentPage = body.page;
    renderRows(body.orders);
    ordersEmptyEl.hidden = body.total !== 0;
    ordersStatusEl.textContent = statusText(body.page, body.page_size, body.orders.length, body.total);
    renderPager(body.page, body.total_pages);
  } catch {
    if (seq !== loadSeq) return;
    showLoadError('Could not load orders. Check your connection and try again.');
  } finally {
    if (seq === loadSeq) ordersTable.removeAttribute('aria-busy');
  }
}

function goToPage(page) {
  currentPage = page;
  loadOrders();
}

function resetFilters() {
  filtersForm.reset();
  filterErrorEl.textContent = '';
  appliedFilters = {};
  currentPage = 1;
}

filtersForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const filters = readFilters();
  const problem = validateFilters(filters);
  filterErrorEl.textContent = problem;
  if (problem) return;
  appliedFilters = filters;
  currentPage = 1;
  loadOrders();
});

clearBtn.addEventListener('click', () => {
  resetFilters();
  loadOrders();
});

// ---------------------------------------------------------------- summary

async function refreshSummary() {
  const summary = await api('/api/metrics/summary');
  totalOrdersEl.textContent = summary.total_orders ?? '—';
  uniqueCustomersEl.textContent = summary.unique_customers ?? '—';
  avgOrderEl.textContent = money(summary.avg_order_value_cents ?? 0);

  const now = new Date();
  const thirtyAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const revenue = await api(`/api/revenue?from=${isoDate(thirtyAgo)}&to=${isoDate(now)}`);
  revenue30dEl.textContent = money(revenue.revenue_cents ?? 0);
}

select.addEventListener('change', () => {
  resetFilters();
  loadOrders();
  refreshSummary().catch(() => {});
});

loadOrders();
refreshSummary().catch(() => {});
