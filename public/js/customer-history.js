(() => {
    const escape = value => String(value ?? '—').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const phTime = value => { if (!value) return "-"; const date = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : String(value).replace(" ", "T") + "Z"); return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("en-PH", { timeZone: "Asia/Manila", dateStyle: "medium", timeStyle: "short" }); };
    const peso = value => value == null || value === '' ? null : '₱' + Number(value).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    // "out_for_delivery" -> "Out for delivery"
    const words = value => value ? String(value).replace(/_/g, ' ').replace(/^./, c => c.toUpperCase()) : null;
    const badge = value => value ? `<span class="history-badge history-badge-${String(value).toLowerCase().replace(/[^a-z_]/g, '')}">${escape(words(value))}</span>` : '—';
    const day = value => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '')); return m ? new Date(Date.UTC(+m[1], m[2] - 1, +m[3])).toLocaleDateString('en-PH', { timeZone: 'UTC', dateStyle: 'medium' }) : value; };
    // fields: [label, key, true when the value is a status shown as a badge]
    const table = (title, rows, fields) => `<section class="records-card"><h2>${title}</h2><div class="records-table"><table><thead><tr>${fields.map(([label])=>`<th>${label}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr>${fields.map(([,key,isStatus])=>`<td>${isStatus ? badge(row[key]) : escape(row[key])}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${fields.length}">No records.</td></tr>`}</tbody></table></div></section>`;
    const id=Number(new URLSearchParams(location.search).get('id'));
    document.getElementById('printHistory').addEventListener('click',()=>window.print());

    // Station gallons: lent / returned / still out, and new gallons bought.
    function gallonSection(g) {
        const rows = g.entries.map(e => ({ ...e, created_at: phTime(e.created_at), kind: e.kind === 'lent' ? 'Lent' : 'Returned', recorded_by: e.recorded_by || '—', note: e.note || '—' }));
        return `<section class="records-card" id="gallonSection"><h2>Station gallons</h2>
            <p class="records-note"><strong>${g.still_out}</strong> station ${g.still_out === 1 ? 'gallon is' : 'gallons are'} with this customer
            (lent ${g.lent}, returned ${g.returned}). New gallons bought: <strong>${g.bought}</strong> — those belong to the customer.</p>
            <form id="gallonForm" class="records-toolbar" aria-label="Record station gallons">
                <label for="gallonKind" class="visually-hidden">What happened</label>
                <select id="gallonKind"><option value="lent">Lent to the customer</option><option value="returned">Returned by the customer</option></select>
                <label for="gallonQuantity" class="visually-hidden">How many gallons</label>
                <input id="gallonQuantity" type="number" min="1" max="100" step="1" value="1" inputmode="numeric" style="max-width:110px" aria-label="How many gallons">
                <label for="gallonNote" class="visually-hidden">Note</label>
                <input id="gallonNote" type="text" maxlength="200" placeholder="Note (optional), e.g. 2 round gallons">
                <button type="submit">Record</button>
            </form>
            <p id="gallonMessage" role="status"></p>
            <div class="records-table"><table><thead><tr><th>Date</th><th>What</th><th>Gallons</th><th>Note</th><th>Recorded by</th></tr></thead><tbody>
            ${rows.map(r => `<tr><td>${escape(r.created_at)}</td><td>${escape(r.kind)}</td><td>${escape(r.quantity)}</td><td>${escape(r.note)}</td><td>${escape(r.recorded_by)}</td></tr>`).join('') || '<tr><td colspan="5">No gallons lent or returned yet.</td></tr>'}
            </tbody></table></div></section>`;
    }
    async function loadGallons() {
        const response = await fetch('/api/gallons?customer_id=' + id, { cache: 'no-store' });
        const data = await response.json();
        if (!response.ok) throw new Error(data.message);
        const holder = document.getElementById('gallonHolder');
        holder.innerHTML = gallonSection(data);
        document.getElementById('gallonForm').addEventListener('submit', async event => {
            event.preventDefault();
            const message = document.getElementById('gallonMessage');
            const button = event.target.querySelector('button');
            button.disabled = true;
            try {
                const result = await fetch('/api/gallons/record', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
                    customer_id: id, kind: document.getElementById('gallonKind').value,
                    quantity: Number(document.getElementById('gallonQuantity').value), note: document.getElementById('gallonNote').value }) });
                const body = await result.json();
                if (!result.ok) { message.textContent = body.message || 'Unable to record the gallons.'; return; }
                await loadGallons();
                document.getElementById('gallonMessage').textContent = body.message;
            } catch { message.textContent = 'Unable to record the gallons. Check your connection and try again.'; }
            finally { button.disabled = false; }
        });
    }

    (async()=>{
        try {
            const response=await fetch('/api/customer-history?id='+id,{cache:'no-store'});
            const data=await response.json(); if(!response.ok)throw new Error(data.message);
            document.getElementById('historyTitle').textContent=data.customer.customer_name+' — history';
            document.getElementById('historyDetails').innerHTML=
                `<span><i class="bi bi-telephone" aria-hidden="true"></i> ${escape(olvPhone(data.customer.contact_number))}</span>`+
                `<span><i class="bi bi-geo-alt" aria-hidden="true"></i> ${escape(data.customer.address)}</span>`+
                badge(data.customer.status);
            document.getElementById('historySections').innerHTML=
                '<div id="gallonHolder"></div>'+
                table('Orders',data.orders.map(o=>({...o,order_date:phTime(o.order_date),total_amount:peso(o.total_amount),fulfillment_method:words(o.fulfillment_method)})),[['Date','order_date'],['Items','items'],['Total','total_amount'],['Status','status',true],['Method','fulfillment_method']])+
                table('Deliveries',data.deliveries.map(d=>({...d,delivery_date:day(d.delivery_date),customer_received_at:d.customer_received_at?phTime(d.customer_received_at):null})),[['Date','delivery_date'],['Status','status',true],['Received','customer_received_at']]);
            document.getElementById('historyMessage').textContent='';
            await loadGallons();
        } catch(error){document.getElementById('historyMessage').textContent=error.message;}
    })();
})();
