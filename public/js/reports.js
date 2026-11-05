const reportTitle = document.getElementById('reportTitle');
const reportSummary = document.getElementById('reportSummary');
const reportResult = document.getElementById('reportResult');
let reportRequest = 0;
let currentReport = null; // { config, rows, from, to }
let preparedBy = '';

// Each report lists its columns in display order. Types control formatting:
// money = ₱1,234.50, datetime = stored in UTC and shown in Philippine time.
const reports = {
    inventory: {
        title: 'Inventory Report',
        description: 'Current stock on hand, minimum stock levels, and the value of stock for every product.',
        columns: [['product_name', 'Product'], ['unit', 'Unit'], ['price', 'Unit Price', 'money'],
            ['quantity', 'On Hand', 'number', true], ['minimum_stock', 'Minimum Stock', 'number'], ['stock_value', 'Stock Value', 'money', true],
            ['stock_status', 'Stock Status', 'label'], ['status', 'Product Status', 'label']],
        prepare: row => ({ ...row, stock_value: Number(row.price || 0) * Number(row.quantity || 0) }),
        summary: rows => [['Products', rows.length], ['Low stock', rows.filter(row => row.stock_status === 'Low Stock').length], ['Total stock value', peso(sum(rows, 'stock_value'))]]
    },
    sales: {
        title: 'Sales Report',
        description: 'Completed orders and the sales they earned.',
        dateColumn: 'order_date',
        columns: [['order_id', 'Order #'], ['order_date', 'Date', 'datetime'], ['customer_name', 'Customer'], ['total_amount', 'Amount', 'money', true]],
        summary: rows => [['Completed orders', rows.length], ['Total sales', peso(sum(rows, 'total_amount'))], ['Average sale', peso(rows.length ? sum(rows, 'total_amount') / rows.length : 0)]]
    },
    delivery: {
        title: 'Delivery Report',
        description: 'Delivery schedules, destinations, assigned staff, and delivery status.',
        dateColumn: 'delivery_date',
        columns: [['delivery_id', 'Delivery #'], ['order_id', 'Order #'], ['delivery_date', 'Date', 'date'], ['delivery_time', 'Time'], ['customer_name', 'Customer'],
            ['contact_number', 'Contact', 'phone'], ['delivery_items', 'Items'], ['delivery_address', 'Address'], ['assigned_staff', 'Assigned To'], ['status', 'Status', 'label']],
        summary: rows => [['Deliveries', rows.length], ['Received', count(rows, 'delivered')], ['In progress', rows.filter(row => ['scheduled', 'out_for_delivery', 'awaiting_customer'].includes(row.status)).length], ['Cancelled', count(rows, 'cancelled')]]
    },
    customers: {
        title: 'Customer Report',
        description: 'Customer records, contact details, and how much each customer has ordered.',
        columns: [['customer_id', 'ID'], ['customer_name', 'Customer'], ['contact_number', 'Contact', 'phone'], ['address', 'Address'], ['customer_type', 'Type', 'label'],
            ['status', 'Status', 'label'], ['total_orders', 'Orders', 'number', true], ['total_spent', 'Total Spent', 'money', true]],
        summary: rows => [['Customers', rows.length], ['Active', count(rows, 'active')], ['Total spent', peso(sum(rows, 'total_spent'))]]
    },
    transactions: {
        title: 'Transaction / Receipt Report',
        description: 'Completed transactions with their item counts and amounts.',
        dateColumn: 'order_date',
        columns: [['order_id', 'Order #'], ['order_date', 'Date', 'datetime'], ['customer_name', 'Customer'], ['item_count', 'Items', 'number', true],
            ['total_amount', 'Amount', 'money', true], ['status', 'Status', 'label']],
        summary: rows => [['Transactions', rows.length], ['Total amount', peso(sum(rows, 'total_amount'))]]
    },
    gallons: {
        title: 'Station Gallon Report',
        description: 'Station gallons lent to customers, gallons returned, how many each customer still holds, and new gallons customers bought.',
        columns: [['customer_name', 'Customer'], ['contact_number', 'Contact', 'phone'], ['lent', 'Lent', 'number', true], ['returned', 'Returned', 'number', true],
            ['still_out', 'Still With Customer', 'number', true], ['bought', 'New Gallons Bought', 'number', true], ['last_change', 'Last Lent/Returned', 'datetime']],
        summary: rows => [['Station gallons still out', sum(rows, 'still_out')], ['Customers holding gallons', rows.filter(row => Number(row.still_out) > 0).length],
            ['Lent in total', sum(rows, 'lent')], ['New gallons sold', sum(rows, 'bought')]]
    },
    remittance: {
        title: 'Cash Remittance Report',
        description: 'Cash collected by drivers on delivery and when it was handed over to the station.',
        dateColumn: 'dropped_off_at',
        columns: [['delivery_id', 'Delivery #'], ['order_id', 'Order #'], ['dropped_off_at', 'Collected', 'datetime'], ['customer_name', 'Customer'], ['driver', 'Driver'],
            ['cash_collected', 'Cash', 'money', true], ['remittance_status', 'Status', 'label'], ['remitted_at', 'Remitted', 'datetime'], ['received_by', 'Received By']],
        summary: rows => {
            const waiting = rows.filter(row => row.remittance_status === 'not_yet_remitted');
            return [['Cash collected', peso(sum(rows, 'cash_collected'))], ['Remitted', peso(sum(rows, 'cash_collected') - sum(waiting, 'cash_collected'))],
                ['Not yet remitted', peso(sum(waiting, 'cash_collected'))], ['Deliveries', rows.length]];
        }
    }
};

const reportButtons = [
    ['inventoryReportButton', 'inventory'], ['salesReportButton', 'sales'], ['deliveryReportButton', 'delivery'],
    ['customerReportButton', 'customers'], ['transactionReportButton', 'transactions'], ['remittanceReportButton', 'remittance'], ['gallonReportButton', 'gallons']
];
for (const [button, key] of reportButtons) {
    document.getElementById(button).addEventListener('click', () => loadReport(key));
}

function peso(value) {
    return '₱' + Number(value || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function sum(rows, key) { return rows.reduce((total, row) => total + Number(row[key] || 0), 0); }
function count(rows, status) { return rows.filter(row => row.status === status).length; }
function toDate(value) {
    const date = new Date(String(value).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? '' : 'Z'));
    return Number.isNaN(date.getTime()) ? null : date;
}
function formatLongDate(day) {
    const date = new Date(day + 'T00:00:00');
    return Number.isNaN(date.getTime()) ? day : date.toLocaleDateString('en-PH', { dateStyle: 'long' });
}
function formatCell(value, type) {
    if (value === null || value === undefined || value === '') return '-';
    if (type === 'money') return peso(value);
    if (type === 'number') return Number(value).toLocaleString('en-PH');
    if (type === 'date') return formatLongDate(String(value).slice(0, 10));
    if (type === 'datetime') {
        const date = toDate(value);
        return date ? date.toLocaleString('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short' }) : String(value);
    }
    if (type === 'phone') return olvPhone(value);
    if (type === 'label') return String(value).replace(/[_-]/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());
    return String(value);
}

async function loadReport(key) {
    const config = reports[key];
    const request = ++reportRequest;
    const reportDialog = document.getElementById('reportDisplayCard');
    if (!reportDialog.open) reportDialog.showModal();
    reportDialog.scrollTop = 0;
    reportTitle.textContent = config.title;
    reportSummary.textContent = 'Loading report...';
    reportResult.replaceChildren();
    try {
        const response = await fetch('/api/reports/' + key, { cache: 'no-store' });
        if (response.status === 401) { window.location.href = '/login'; return; }
        const data = await response.json();
        if (!response.ok || data.success === false) throw new Error(data.message || 'Unable to load report. Please try again.');
        // A slower request must not replace a more recently selected report.
        if (request !== reportRequest) return;
        const rows = (Array.isArray(data.report) ? data.report : []).map(config.prepare || (row => row));
        currentReport = { config, rows };
        renderReport();
    } catch (error) {
        if (request !== reportRequest) return;
        currentReport = null;
        reportSummary.textContent = error.message;
        reportResult.textContent = 'Refresh the report. If the problem continues, contact the administrator.';
    }
}

// Period drop-down (Today, This week, ...) for reports with a date. Days are counted
// in Philippine time; the week starts on Monday.
const PERIOD_LABELS = { all: 'All dates', today: 'Today', week: 'This week', month: 'This month', 'last-month': 'Last month', year: 'This year' };
const phDay = date => date.toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' }); // "YYYY-MM-DD"
function periodRange(period) {
    const today = phDay(new Date());
    const [y, m, d] = today.split('-').map(Number);
    const key = date => date.toISOString().slice(0, 10);
    const utcDay = (year, month, day) => new Date(Date.UTC(year, month - 1, day));
    if (period === 'today') return [today, today];
    if (period === 'week') { const start = utcDay(y, m, d - ((utcDay(y, m, d).getUTCDay() + 6) % 7)); return [key(start), today]; }
    if (period === 'month') return [`${today.slice(0, 7)}-01`, today];
    if (period === 'last-month') return [key(utcDay(y, m - 1, 1)), key(utcDay(y, m, 0))];
    if (period === 'year') return [`${y}-01-01`, today];
    return null;
}
// The day a record belongs to, in Philippine time. Dates without a time ("2026-10-25")
// are already station days; date-times are stored in UTC.
function recordDay(value) {
    if (!value) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return String(value);
    const date = toDate(value);
    return date ? phDay(date) : null;
}
function filteredRows() {
    const { config, rows } = currentReport;
    const range = config.dateColumn ? periodRange(document.getElementById('reportPeriodSelect').value) : null;
    if (!range) return rows;
    return rows.filter(row => { const day = recordDay(row[config.dateColumn]); return day && day >= range[0] && day <= range[1]; });
}
document.getElementById('reportPeriodSelect').addEventListener('change', () => { if (currentReport) renderReport(); });

function renderReport() {
    const { config } = currentReport;
    const rows = filteredRows();
    document.getElementById('reportDocumentTitle').textContent = config.title;
    document.getElementById('reportDescription').textContent = config.description;
    const period = document.getElementById('reportPeriodSelect').value;
    const range = config.dateColumn ? periodRange(period) : null;
    document.getElementById('reportPeriodPicker').hidden = !config.dateColumn;
    document.getElementById('reportPeriod').textContent = !config.dateColumn ? 'Current records as of today'
        : range ? `${PERIOD_LABELS[period]} (${formatLongDate(range[0])}${range[0] === range[1] ? '' : ` – ${formatLongDate(range[1])}`})` : 'All dates';
    document.getElementById('reportGenerated').textContent = new Date().toLocaleString('en-PH', { dateStyle: 'long', timeStyle: 'short' });
    document.getElementById('reportPreparedBy').textContent = preparedBy || '-';
    document.getElementById('reportSignatureName').textContent = preparedBy || ' ';

    reportSummary.replaceChildren(...config.summary(rows).map(([label, value]) => {
        const item = document.createElement('div');
        item.className = 'report-stat';
        const number = document.createElement('strong');
        number.textContent = typeof value === 'number' ? value.toLocaleString('en-PH') : value;
        const caption = document.createElement('span');
        caption.textContent = label;
        item.append(number, caption);
        return item;
    }));
    if (!rows.length) { reportResult.textContent = currentReport.rows.length ? 'No records in this period. Choose another period above.' : 'No records found for this report.'; return; }

    const table = document.createElement('table');
    table.className = 'table table-bordered table-striped report-table';
    const header = table.createTHead().insertRow();
    for (const [, label, type] of config.columns) {
        const cell = document.createElement('th');
        cell.textContent = type === 'money' ? `${label} (₱)` : label;
        if (type === 'money' || type === 'number') cell.className = 'num';
        header.appendChild(cell);
    }
    const body = table.createTBody();
    for (const record of rows) {
        const row = body.insertRow();
        for (const [key, , type] of config.columns) {
            const cell = row.insertCell();
            cell.textContent = formatCell(record[key], type);
            if (type === 'money' || type === 'number') cell.className = 'num';
        }
    }
    // Totals row for the columns where adding up makes sense.
    if (config.columns.some(column => column[3])) {
        const totals = table.createTFoot().insertRow();
        config.columns.forEach(([key, , type, total], index) => {
            const cell = totals.insertCell();
            if (index === 0) cell.textContent = 'TOTAL';
            if (total) { cell.textContent = formatCell(sum(rows, key), type); cell.className = 'num'; }
        });
    }
    reportResult.replaceChildren(table);
}

// Download the displayed report as a formatted Excel file (xlsx-report.js): the same
// letterhead, summary, table and totals as on screen. Amounts and counts stay real
// numbers, so Excel can still add them up; everything else is shown as on screen.
function buildReportWorkbook() {
    const { config } = currentReport;
    const rows = filteredRows();
    return window.olvReportXlsx({
        title: config.title,
        description: config.description,
        address: document.querySelector('.report-letterhead span')?.textContent.trim() || '',
        coverage: document.getElementById('reportPeriod').textContent,
        generated: document.getElementById('reportGenerated').textContent,
        preparedBy: preparedBy || '',
        summary: config.summary(rows),
        columns: config.columns.map(([, label, type, total]) => ({ label, type: type === 'money' || type === 'number' ? type : 'text', total: Boolean(total) })),
        rows: rows.map(row => config.columns.map(([key, , type]) => type === 'money' ? Number(row[key] || 0)
            : type === 'number' && row[key] !== null && row[key] !== undefined && row[key] !== '' ? Number(row[key]) : formatCell(row[key], type)))
    });
}
document.getElementById('exportReportButton').addEventListener('click', () => {
    if (!currentReport || !filteredRows().length) { alert('Load a report with records first.'); return; }
    const url = URL.createObjectURL(buildReportWorkbook());
    const link = document.createElement('a');
    link.href = url;
    link.download = `OLV-${currentReport.config.title.replace(/[^a-z0-9]+/gi, '-')}-${new Date().toISOString().slice(0, 10)}.xlsx`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
});

document.getElementById('printReportButton').addEventListener('click', () => {
    if (!currentReport || !reportResult.querySelector('table')) { alert('Load a report with records first.'); return; }
    const printWindow = window.open('', '_blank', 'width=1000,height=750');
    if (!printWindow) { alert('Allow pop-ups to print this report.'); return; }
    const page = printWindow.document;
    page.title = `OLV Water Refilling Station - ${currentReport.config.title}`;
    const style = page.createElement('style');
    style.textContent = `
        @page{size:A4 landscape;margin:14mm}
        body{font-family:Arial,sans-serif;color:#111;margin:0}
        .report-letterhead{text-align:center;border-bottom:2px solid #111;padding-bottom:10px;margin-bottom:12px}
        .report-letterhead strong{display:block;font-size:20px}
        .report-letterhead span{font-size:12px}
        .report-letterhead h3{margin:10px 0 2px;font-size:17px;text-transform:uppercase;letter-spacing:.5px}
        .report-description{margin:0 0 6px;font-size:12px;color:#444}
        .report-meta{display:flex;justify-content:center;gap:28px;margin:0;font-size:12px}
        .report-meta dt{display:inline;font-weight:bold}.report-meta dt::after{content:": "}.report-meta dd{display:inline;margin:0}
        .report-summary{display:flex;gap:10px;margin:0 0 12px}
        .report-stat{border:1px solid #999;padding:6px 10px;flex:1}.report-stat strong{display:block;font-size:15px}.report-stat span{font-size:11px}
        table{width:100%;border-collapse:collapse;font-size:11px}
        th,td{border:1px solid #777;padding:5px 6px;text-align:left;vertical-align:top}
        th{background:#e9ecef}.num{text-align:right;white-space:nowrap}
        tfoot td{font-weight:bold;background:#f3f4f6}
        thead{display:table-header-group}tr{page-break-inside:avoid}
        .report-signatures{display:flex;justify-content:space-around;margin-top:48px;font-size:12px;page-break-inside:avoid}
        .report-signatures div{text-align:center;min-width:220px}
        .report-signatures span{display:block;border-bottom:1px solid #111;margin-bottom:4px;min-height:18px;font-weight:bold}`;
    page.head.appendChild(style);
    page.body.appendChild(page.importNode(document.getElementById('reportDocument'), true));
    printWindow.focus();
    printWindow.print();
});

document.getElementById('emailReportButton').addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
        const response = await fetch('/api/reports/email', { method: 'POST' });
        const data = await response.json();
        alert(data.message || 'Unable to email report.');
    } catch { alert('Unable to connect to the email service.'); }
    finally { button.disabled = false; }
});
// Quick links from the dashboard menu open a report directly: ?report=sales
const requestedReport = new URLSearchParams(window.location.search).get('report');
if (Object.hasOwn(reports, requestedReport)) loadReport(requestedReport);
document.getElementById('closeReportButton').addEventListener('click', () => document.getElementById('reportDisplayCard').close());
// Clicking the dark area outside the pop-up also closes it.
document.getElementById('reportDisplayCard').addEventListener('click', event => {
    if (event.target === event.currentTarget) event.currentTarget.close();
});
fetch('/api/current-user', { cache: 'no-store' })
    .then(response => response.ok ? response.json() : null)
    .then(data => {
        const user = data?.user;
        if (user) preparedBy = `${user.full_name || user.username} (${String(user.role || '').replace(/\b\w/g, letter => letter.toUpperCase())})`;
    })
    .catch(() => {});
