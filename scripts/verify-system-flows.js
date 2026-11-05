const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const sqlite3 = require('sqlite3');
const bcrypt = require('bcrypt');

// Every run gets a fresh database. Never seed or modify the user's live database.
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'olv-system-test-'));
const dbPath = path.join(work, 'test.db');
let server, db, output = '';
const checks = [];
const env = { ...process.env, OLV_DB_PATH: dbPath, GMAIL_USER: '', GMAIL_APP_PASSWORD: '', OLV_DISABLE_AUTO_BACKUP: '1', HTTPS_KEY: '', HTTPS_CERT: '', ROUTING_URL: '' };
const run = (sql, values = []) => new Promise((resolve, reject) => db.run(sql, values, function(error) { error ? reject(error) : resolve(this); }));
const get = (sql, values = []) => new Promise((resolve, reject) => db.get(sql, values, (error, row) => error ? reject(error) : resolve(row)));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function check(name, condition) { assert.ok(condition, name); checks.push(name); console.log('PASS:', name); }
async function main() {
    const init = spawnSync(process.execPath, ['database/init.js'], { env, encoding: 'utf8', windowsHide: true });
    if (init.error) throw init.error;
    assert.equal(init.status, 0, init.stderr);
    db = new sqlite3.Database(dbPath);
    const password = 'TestStation2026!';
    const hash = await bcrypt.hash(password, 10);
    await run("INSERT INTO users(username,password,full_name,contact_number,role) VALUES('testadmin',?,'Test Admin','09123456789','admin'),('teststaff',?,'Test Staff','09123456788','staff')", [hash,hash]);
    await run("INSERT INTO users(username,password,full_name,contact_number,role) VALUES('testdriver',?,'Test Driver','09123456780','driver'),('otherdriver',?,'Other Driver','09123456781','driver')", [hash,hash]);
    await run("INSERT INTO customers(customer_name,contact_number,address,city,barangay,street,house_number,customer_type,status) VALUES('Test Customer','09123456787','1 Test Street','Legazpi City','Rawis','Test Street','1','Regular','active'),('Other Customer','09123456786','2 Test Street','Legazpi City','Rawis','Test Street','2','Regular','active')");
    await run("INSERT INTO customer_accounts(customer_id,username,password,status) VALUES(1,'testcustomer',?,'active'),(2,'othercustomer',?,'active')", [hash,hash]);
    await run("INSERT INTO products(product_name,category,unit,price,status) VALUES('Test water','Water','gallon',30,'active')");
    await run("INSERT INTO inventory(product_id,quantity,minimum_stock,stock_status) VALUES(1,100,5,'available')");
    const port = await new Promise(resolve => { const socket = net.createServer(); socket.listen(0,'127.0.0.1',()=>{ const port=socket.address().port; socket.close(()=>resolve(port)); }); });
    env.PORT=String(port);
    server=spawn(process.execPath,['app.js'],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
    server.stdout.on('data',chunk=>{output+=chunk;}); server.stderr.on('data',chunk=>{output+=chunk;});
    server.on('error',error=>{output+=error.message;});
    const base=`http://127.0.0.1:${port}`;
    let connected=false;
    for(let i=0;i<80;i++){try{const r=await fetch(base+'/');if(r.ok){connected=true;break;}}catch{} await wait(100);}
    assert.ok(connected,output);
    await wait(300);
    async function api(route, method='GET', cookie='', body) {
        const response=await fetch(base+route,{method,headers:{Cookie:cookie,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
        const text=await response.text(); let data;try{data=JSON.parse(text);}catch{data=text;}
        return {status:response.status,data,cookie:response.headers.get('set-cookie')?.split(';')[0]};
    }
    async function login(username){const result=await api('/login','POST','',{username,password});assert.equal(result.status,200,JSON.stringify(result.data));return result.cookie;}
    const admin=await login('testadmin'),staff=await login('teststaff'),customer=await login('testcustomer'),other=await login('othercustomer');
    // Sagpon is a barangay of both Legazpi City and Daraga.
    const profile = {full_name:'Test Customer',city:'Daraga',barangay:'Sagpon',street:'Test Street',house_number:'1'};
    const savedContact=(await api('/api/customer/profile','GET',customer)).data.customer.contact_number;
    check('Customer can save Daraga municipality',(await api('/api/customer/profile','PUT',customer,profile)).status===200);
    check('Portal save keeps the contact number on file',(await api('/api/customer/profile','GET',customer)).data.customer.contact_number===savedContact);
    check('Barangay from another city is rejected',(await api('/api/customer/profile','PUT',customer,{...profile,barangay:'Rawis'})).status===400);
    check('Unlisted barangay is rejected',(await api('/api/customer/profile','PUT',customer,{...profile,barangay:'Nowhere'})).status===400);
    check('Daraga is stored in customer address',(await api('/api/customer/profile','GET',customer)).data.customer.address.includes('Daraga'));
    check('Unsupported municipality is rejected',(await api('/api/customer/profile','PUT',customer,{...profile,city:'Other'})).status===400);
    check('Rejected address leaves saved city unchanged',(await api('/api/customer/profile','GET',customer)).data.customer.city==='Daraga');
    check('Customer can save Legazpi City',(await api('/api/customer/profile','PUT',customer,{...profile,city:'Legazpi City'})).status===200);
    await run("INSERT INTO verified_contacts VALUES('customer',1,'email','customer@example.com')");
    check('Admin account list includes verified email',(await api('/api/customer-accounts','GET',admin)).data.accounts.some(account=>account.email==='customer@example.com' && account.email_verified===1));
    check('Admin account editor includes email',(await api('/api/customers/account?customer_id=1','GET',admin)).data.account.email==='customer@example.com');
    check('Staff cannot change customer email',(await api('/api/customers/email/request','POST',staff,{customer_id:1,email:'new@example.com'})).status===403);
    check('Missing email provider leaves address unchanged',(await api('/api/customers/email/request','POST',admin,{customer_id:1,email:'new@example.com'})).status===503 && (await api('/api/customers/account?customer_id=1','GET',admin)).data.account.email==='customer@example.com');
    const driver=await login('testdriver'), otherDriver=await login('otherdriver');
    check('Driver cannot access inventory',(await api('/api/inventory','GET',driver)).status===403);
    check('Unauthenticated access rejected',(await api('/api/orders')).status===401);
    check('Customers cannot use staff record routes',(await api('/api/customer-history?id=1','GET',customer)).status===403);
    check('Staff cannot manage accounts',(await api('/staff-accounts','GET',staff)).status===403);
    let result=await api('/api/customer/orders','POST',customer,{product_id:1,quantity:2,fulfillment_method:'pickup'});
    check('Customer creates pickup order',result.status===200 || result.status===201);
    const order=(await api('/api/customer/orders','GET',customer)).data.orders[0];
    assert.ok(order);
    // Pickups are confirmed by staff at the counter; customers cannot complete them from home.
    check('Customers cannot mark their own pickup as collected',(await api('/api/customer/orders/complete','PUT',customer,{order_id:order.order_id})).status===403
        && (await get('SELECT status FROM orders WHERE order_id=?',[order.order_id])).status==='pending');
    result=await api('/api/orders/complete','PUT',staff,{order_id:order.order_id});
    check('Staff confirm the pickup at the counter',result.status===200);
    check('Completion deducts inventory exactly once',(await get('SELECT quantity FROM inventory WHERE product_id=1')).quantity===98);
    await api('/api/orders/complete','PUT',staff,{order_id:order.order_id});
    check('Repeated completion does not deduct again',(await get('SELECT quantity FROM inventory WHERE product_id=1')).quantity===98);
    result=await api('/api/customer/orders','POST',customer,{product_id:1,quantity:1,fulfillment_method:'delivery'});
    check('Customer creates delivery order',result.status===200 || result.status===201);
    const deliveryOrder=(await api('/api/customer/orders','GET',customer)).data.orders.find(o=>o.fulfillment_method==='delivery');
    const deliveryId=deliveryOrder.delivery_id;
    const staffDeliveries=(await api('/api/deliveries','GET',staff)).data;
    check('New portal order appears first in the Delivery list',staffDeliveries[0] && staffDeliveries[0].order_id===deliveryOrder.order_id);
    const staffOrder=(await api('/api/orders','GET',staff)).data.find(o=>o.order_id===deliveryOrder.order_id);
    check('Orders list shows the same delivery status',staffOrder && staffOrder.delivery_status==='scheduled' && staffOrder.delivery_id===deliveryId);
    check('Pickup order is labeled pickup in the Orders list',(await api('/api/orders','GET',staff)).data.find(o=>o.order_id===order.order_id).fulfillment_method==='pickup');
    check('Drivers see a new unassigned portal delivery',(await api('/api/deliveries','GET',driver)).data.some(d=>d.delivery_id===deliveryId && d.assigned_to==null) && (await api('/api/deliveries','GET',otherDriver)).data.some(d=>d.delivery_id===deliveryId));
    check('Drivers can open tracking for an unassigned delivery',(await api('/api/deliveries/tracking?delivery_id='+deliveryId,'GET',driver)).status===200);
    const schedule = {delivery_id:deliveryId,order_id:deliveryOrder.order_id,delivery_date:'2026-10-01',delivery_time:'09:00',delivery_address:'1 Test Street, Legazpi City',delivery_reason:'Customer order',assigned_to:3,status:'scheduled'};
    check('Staff can assign scheduled delivery',(await api('/api/deliveries/update','PUT',staff,schedule)).status===200);
    check('Assignment is persisted',(await get('SELECT assigned_to FROM delivery_schedules WHERE delivery_id='+deliveryId)).assigned_to===3);
    check('Duplicate active delivery rejected',(await api('/api/deliveries/add','POST',staff,schedule)).status===409);
    check('Invalid calendar date rejected',(await api('/api/deliveries/update','PUT',staff,{...schedule,delivery_date:'2026-02-30'})).status===400);
    check('Invalid assignee rejected',(await api('/api/deliveries/update','PUT',staff,{...schedule,assigned_to:999})).status===400);
    check('Pickup cannot be scheduled for delivery',(await api('/api/deliveries/add','POST',staff,{...schedule,order_id:order.order_id})).status===400);
    check('Driver cannot edit assignment',(await api('/api/deliveries/update','PUT',driver,schedule)).status===403);
    check('Other driver cannot view delivery',(await api('/api/deliveries','GET',otherDriver)).data.length===0);
    check('Assigned driver sees delivery',(await api('/api/deliveries','GET',driver)).data.length===1);
    check('Other driver cannot start delivery',(await api('/api/deliveries/status','PUT',otherDriver,{delivery_id:deliveryId,status:'out_for_delivery'})).status!==200);
    check('Delivery cannot be received before drop-off',(await api('/api/customer/delivery/received','PUT',customer,{delivery_id:deliveryId})).status===400);
    check('Delivery starts from scheduled',(await api('/api/deliveries/status','PUT',driver,{delivery_id:deliveryId,status:'out_for_delivery'})).status===200);
    check('Other driver cannot confirm drop-off',(await api('/api/deliveries/status','PUT',otherDriver,{delivery_id:deliveryId,status:'delivered'})).status===403);
    check('Drop-off awaits customer confirmation',(await api('/api/deliveries/status','PUT',driver,{delivery_id:deliveryId,status:'delivered'})).status===200);
    const photo='data:image/jpeg;base64,'+Buffer.from([255,216,255,224,0,255,217]).toString('base64');
    check('Other customer cannot attach delivery proof',(await api('/api/customer/delivery/photo','POST',other,{delivery_id:deliveryId,photo})).status===404);
    check('Customer can attach optional delivery proof',(await api('/api/customer/delivery/photo','POST',customer,{delivery_id:deliveryId,photo})).status===200);
    check('Receipt confirmation completes delivery order',(await api('/api/customer/delivery/received','PUT',customer,{delivery_id:deliveryId})).status===200);
    const tracked=await api('/api/deliveries/tracking?delivery_id='+deliveryId,'GET',customer);
    check('Customer sees full delivery tracking history',tracked.status===200 && ['out_for_delivery','awaiting_customer','delivered'].every(status=>tracked.data.events.some(event=>event.status===status)));
    check('Other customer cannot track delivery',(await api('/api/deliveries/tracking?delivery_id='+deliveryId,'GET',other)).status===404);
    check('Other driver cannot track delivery',(await api('/api/deliveries/tracking?delivery_id='+deliveryId,'GET',otherDriver)).status===404);
    const completedDelivery=(await api('/api/customer/orders','GET',customer)).data.orders.find(o=>o.order_id===deliveryOrder.order_id);
    check('Delivery received and order completed agree',completedDelivery.status==='completed' && completedDelivery.delivery_status==='delivered');
    check('Schedule editor cannot reopen completed delivery',(await api('/api/deliveries/update','PUT',staff,schedule)).status!==200);
    check('Completed delivery cannot restart',(await api('/api/deliveries/status','PUT',staff,{delivery_id:deliveryId,status:'out_for_delivery'})).status!==200);
    check('Completed delivery cannot be cancelled',(await api('/api/deliveries/status','PUT',staff,{delivery_id:deliveryId,status:'cancelled'})).status!==200);
    // The Container Tracking area was removed from the system.
    check('Container page is no longer available',(await api('/containers','GET',staff)).status===404);
    check('Container records API is no longer available',(await api('/api/containers','GET',staff)).status===404);
    result=await api('/api/customer-history?id=1','GET',staff);
    check('Customer history includes orders without a container section',result.data.orders.length===2 && result.data.containers===undefined);
    check('Customer history has no payment or credit section',result.data.payments===undefined && result.data.credit===undefined);
    // Payments and credit were removed from the system.
    check('Payment recording is no longer available',(await api('/api/payments/record','POST',staff,{order_id:order.order_id,amount:'20',method:'Cash'})).status===404);
    check('Customers cannot reach payment routes',(await api('/api/payments/orders','GET',customer)).status===403);
    check('Credit report is no longer available',(await api('/api/reports/credit','GET',staff)).status===404);
    const beforeStock = (await get('SELECT quantity FROM inventory WHERE product_id=1')).quantity;
    const beforeMovements = (await get('SELECT COUNT(*) AS count FROM inventory_movements')).count;
    const additions = await Promise.all([api('/api/inventory/stock-in','POST',staff,{product_id:1,quantity:2}),api('/api/inventory/stock-in','POST',staff,{product_id:1,quantity:3})]);
    check('Concurrent stock additions both succeed',additions.every(result=>result.status===200));
    check('Concurrent additions do not lose stock',(await get('SELECT quantity FROM inventory WHERE product_id=1')).quantity===beforeStock+5);
    const removals = await Promise.all([api('/api/inventory/stock-out','POST',staff,{product_id:1,quantity:80}),api('/api/inventory/stock-out','POST',staff,{product_id:1,quantity:80})]);
    check('Concurrent withdrawals cannot oversell',removals.filter(result=>result.status===200).length===1 && removals.filter(result=>result.status===400).length===1);
    check('Stock and movement history stay consistent',(await get('SELECT quantity FROM inventory WHERE product_id=1')).quantity===beforeStock+5-80 && (await get('SELECT COUNT(*) AS count FROM inventory_movements')).count===beforeMovements+3);
    // A driver takes an unassigned delivery by starting it; the other driver then cannot.
    await api('/api/customer/orders','POST',customer,{product_id:1,quantity:1,fulfillment_method:'delivery'});
    const openDelivery=(await api('/api/deliveries','GET',staff)).data.find(d=>d.status==='scheduled' && d.assigned_to==null);
    check('Driver can take an unassigned delivery by starting it',openDelivery && (await api('/api/deliveries/status','PUT',otherDriver,{delivery_id:openDelivery.delivery_id,status:'out_for_delivery'})).status===200);
    check('Taken delivery is assigned to that driver',(await get('SELECT assigned_to FROM delivery_schedules WHERE delivery_id='+openDelivery.delivery_id)).assigned_to===(await get("SELECT user_id FROM users WHERE username='otherdriver'")).user_id);
    check('A second driver cannot take the same delivery',(await api('/api/deliveries/status','PUT',driver,{delivery_id:openDelivery.delivery_id,status:'out_for_delivery'})).status===409 && !(await api('/api/deliveries','GET',driver)).data.some(d=>d.delivery_id===openDelivery.delivery_id));
    const handOver={delivery_id:openDelivery.delivery_id,order_id:openDelivery.order_id,delivery_date:'2026-10-01',delivery_time:'',delivery_address:'1 Test Street, Legazpi City',delivery_reason:'Customer order delivery'};
    check('Out-for-delivery cannot be left with nobody assigned',(await api('/api/deliveries/update','PUT',staff,{...handOver,assigned_to:null})).status===400);
    check('Staff can hand an out-for-delivery delivery to another driver',(await api('/api/deliveries/update','PUT',staff,{...handOver,assigned_to:3})).status===200
        && (await get('SELECT assigned_to, status FROM delivery_schedules WHERE delivery_id='+openDelivery.delivery_id)).assigned_to===3
        && (await api('/api/deliveries','GET',driver)).data.some(d=>d.delivery_id===openDelivery.delivery_id && d.status==='out_for_delivery'));
    // Drop-off for a customer with a saved location (Legazpi City coordinates).
    check('Customer location outside Legazpi City and Daraga is rejected',(await api('/api/customer/location','PUT',customer,{latitude:14.5995,longitude:120.9842,accuracy:20})).status===400);
    check('Imprecise customer location is rejected',(await api('/api/customer/location','PUT',customer,{latitude:13.1391,longitude:123.7438,accuracy:5000})).status===400);
    check('Customer can save a delivery location',(await api('/api/customer/location','PUT',customer,{latitude:13.1391,longitude:123.7438,accuracy:20})).status===200);
    const far=await api('/api/deliveries/status','PUT',driver,{delivery_id:openDelivery.delivery_id,status:'delivered',driver_latitude:13.25,driver_longitude:123.6,driver_accuracy:15});
    check('Driver far from the customer is asked before recording the drop-off',far.status===409 && far.data.code==='LOCATION_MISMATCH');
    check('Driver whose phone shares no location can still record the drop-off',(await api('/api/deliveries/status','PUT',driver,{delivery_id:openDelivery.delivery_id,status:'delivered'})).status===200);
    const noLocationTrack=(await api('/api/deliveries/tracking?delivery_id='+openDelivery.delivery_id,'GET',staff)).data;
    check('Tracking history says the location was not checked',noLocationTrack.delivery.status==='awaiting_customer' && noLocationTrack.events.some(e=>e.status==='awaiting_customer' && /location not checked/.test(e.note)));
    await api('/api/customer/orders','POST',customer,{product_id:1,quantity:1,fulfillment_method:'delivery'});
    const staffDelivery=(await api('/api/deliveries','GET',staff)).data.find(d=>d.status==='scheduled' && d.assigned_to==null);
    await api('/api/deliveries/status','PUT',staff,{delivery_id:staffDelivery.delivery_id,status:'out_for_delivery'});
    check('A bad drop-off photo is rejected before anything is saved',(await api('/api/deliveries/status','PUT',staff,{delivery_id:staffDelivery.delivery_id,status:'delivered',photo:'data:image/png;base64,AAAA'})).status===400);
    check('Staff can record a drop-off from the station without a location',(await api('/api/deliveries/status','PUT',staff,{delivery_id:staffDelivery.delivery_id,status:'delivered'})).status===200
        && (await api('/api/deliveries/tracking?delivery_id='+staffDelivery.delivery_id,'GET',staff)).data.events.some(e=>e.status==='awaiting_customer' && /\(staff\)/.test(e.note)));
    // Drop-off with the optional photo.
    await api('/api/customer/orders','POST',customer,{product_id:1,quantity:1,fulfillment_method:'delivery'});
    const photoDelivery=(await api('/api/deliveries','GET',staff)).data.find(d=>d.status==='scheduled' && d.assigned_to==null);
    await api('/api/deliveries/status','PUT',staff,{delivery_id:photoDelivery.delivery_id,status:'out_for_delivery'});
    check('Drop-off can include a photo',(await api('/api/deliveries/status','PUT',staff,{delivery_id:photoDelivery.delivery_id,status:'delivered',photo})).status===200
        && (await api('/api/deliveries','GET',staff)).data.find(d=>d.delivery_id===photoDelivery.delivery_id).has_dropoff_photo===1);
    check('Customer sees and can open the drop-off photo',(await api('/api/customer/orders','GET',customer)).data.orders.some(o=>o.delivery_id===photoDelivery.delivery_id && o.has_dropoff_photo===1)
        && (await fetch(base+'/api/deliveries/dropoff-photo?delivery_id='+photoDelivery.delivery_id,{headers:{Cookie:customer}})).headers.get('content-type')==='image/jpeg');
    check('Other customers and unassigned drivers cannot open the drop-off photo',(await api('/api/deliveries/dropoff-photo?delivery_id='+photoDelivery.delivery_id,'GET',other)).status===404
        && (await api('/api/deliveries/dropoff-photo?delivery_id='+photoDelivery.delivery_id,'GET',driver)).status===404);
    // Driver location that does not match, and a location too rough to compare.
    const startOpenDelivery=async()=>{
        await api('/api/customer/orders','POST',customer,{product_id:1,quantity:1,fulfillment_method:'delivery'});
        const d=(await api('/api/deliveries','GET',staff)).data.find(x=>x.status==='scheduled' && x.assigned_to==null);
        await api('/api/deliveries/status','PUT',driver,{delivery_id:d.delivery_id,status:'out_for_delivery'});
        return d.delivery_id;
    };
    const lastNote=async id=>(await api('/api/deliveries/tracking?delivery_id='+id,'GET',staff)).data.events.filter(e=>e.status==='awaiting_customer').pop()?.note||'';
    const mismatchId=await startOpenDelivery();
    check('Driver can record a mismatched drop-off after confirming',(await api('/api/deliveries/status','PUT',driver,{delivery_id:mismatchId,status:'delivered',driver_latitude:13.25,driver_longitude:123.6,driver_accuracy:15,accept_location_mismatch:true})).status===200
        && /LOCATION DID NOT MATCH/.test(await lastNote(mismatchId)));
    const roughId=await startOpenDelivery();
    check('A rough phone location is recorded as not checked',(await api('/api/deliveries/status','PUT',driver,{delivery_id:roughId,status:'delivered',driver_latitude:14.6,driver_longitude:121,driver_accuracy:40000})).status===200
        && /only accurate to about/.test(await lastNote(roughId)));
    const nearId=await startOpenDelivery();
    check('Driver at the customer location passes the check',(await api('/api/deliveries/status','PUT',driver,{delivery_id:nearId,status:'delivered',driver_latitude:13.1392,driver_longitude:123.7439,driver_accuracy:10})).status===200
        && /location checked: within/.test(await lastNote(nearId)));
    check('New deliveries are dated in Philippine time',staffDelivery.delivery_date===new Date(Date.now()+8*3600000).toISOString().slice(0,10));
    check('Staff can archive a product',(await api('/api/inventory/status','PUT',staff,{product_id:1,status:'archived'})).status===200);
    check('Archived product is hidden from the customer portal',!(await api('/api/customer/products','GET',customer)).data.products.some(p=>p.product_id===1));
    check('Archived product can be activated again',(await api('/api/inventory/status','PUT',staff,{product_id:1,status:'active'})).status===200 && (await api('/api/customer/products','GET',customer)).data.products.some(p=>p.product_id===1));
    const february=(await api('/api/dashboard/metrics?month=2026-02','GET',staff)).data;
    check('Dashboard chart can show a chosen month',february.period==='2026-02' && february.trend.length===28 && february.trend[0].day==='2026-02-01');
    const last30=(await api('/api/dashboard/metrics?month=bad','GET',staff)).data;
    check('Invalid month falls back to the last 30 days',last30.period==='last30' && last30.trend.length===30 && typeof last30.sales_30_days==='number');
    check('No-provider recovery fails safely',(await api('/account/recover','POST','',{contact_number:'09123456787',password:'Attack123!',confirm_password:'Attack123!'})).status===503);
    await wait(100);
    check('Successful writes produce activity records',(await get('SELECT COUNT(*) AS count FROM activity_logs')).count>0);
    check('Activity logs exclude passwords',!(await get('SELECT GROUP_CONCAT(description) AS descriptions FROM activity_logs')).descriptions.includes(password));
    check('Staff username cannot shadow a customer',(await api('/api/users/create','POST',admin,{username:'testcustomer',password,confirm_password:password,full_name:'Duplicate',contact_number:'09123456780',role:'staff'})).status===409);
    check('Staff edit rejects phone letters',(await api('/api/users/update','PUT',admin,{user_id:2,full_name:'Test Staff',contact_number:'09abcdefghi',role:'staff',status:'active'})).status===400);
    check('Admin can deactivate staff',(await api('/api/users/update','PUT',admin,{user_id:2,full_name:'Test Staff',contact_number:'09123456788',role:'staff',status:'not active'})).status===200);
    check('Deactivation revokes existing staff session',(await api('/api/orders','GET',staff)).status===401);
    await run('UPDATE customers SET customer_name=? WHERE customer_id=2', ['<img src=x onerror="window.customerMarkupExecuted=true">']);
    await api('/api/customer/orders','POST',customer,{product_id:1,quantity:1,fulfillment_method:'delivery'});
    await run("INSERT INTO verified_contacts VALUES('customer',2,'email','delete@example.com')");
    check('Admin can delete customer without history',(await api('/api/customers/delete','DELETE',admin,{customer_id:2})).status===200);
    check('Deleted account recovery contact is removed',!(await get("SELECT 1 FROM verified_contacts WHERE destination='delete@example.com'")));
    check('Deleted customer session is revoked',(await api('/api/customer/profile','GET',other)).status===401);
    // Keep the hostile-name display fixture on the surviving test customer.
    await run('UPDATE customers SET customer_name=? WHERE customer_id=1', ['<img src=x onerror="window.customerMarkupExecuted=true">']);
    if(process.argv.includes('--browser')) await browserCheck(base, admin, customer, work, checks, driver);
    fs.mkdirSync('miscellaneous/test-results',{recursive:true});
    fs.writeFileSync('miscellaneous/test-results/latest-system-check.json',JSON.stringify({time:new Date().toISOString(),checks,database:'isolated fixture',liveMessagingTested:false},null,2));
    console.log(`${checks.length} system flow checks passed. Live database unchanged.`);
}

async function browserCheck(base, admin, customer, folder, results, driver) {
    const chrome='C:/Program Files/Google/Chrome/Application/chrome.exe';
    if(!fs.existsSync(chrome)) throw new Error('Chrome not found for browser checks.');
    const profile=path.join(folder,'chrome');
    const child=spawn(chrome,['--headless=new','--disable-gpu','--remote-debugging-port=0','--user-data-dir='+profile,'--no-first-run','about:blank'],{windowsHide:true,stdio:'ignore'});
    let ws;
    try {
        const active=path.join(profile,'DevToolsActivePort');
        for(let i=0;i<100&&!fs.existsSync(active);i++)await wait(100);
        const debugPort=fs.readFileSync(active,'utf8').split('\n')[0];
        const targets=await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
        ws=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);
        await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
        let seq=0;const pending=new Map();
        ws.onmessage=event=>{const message=JSON.parse(event.data);if(message.id){const task=pending.get(message.id);pending.delete(message.id);message.error?task.reject(new Error(message.error.message)):task.resolve(message.result);}};
        const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
        const evaluate=async expression=>{
            const result=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
            if(result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
            return result.result.value;
        };
        await send('Network.enable');
        const setCookie=async cookie=>send('Network.setCookie',{name:'sessionId',value:cookie.split('=')[1],url:base});
        await setCookie(admin);
        for(const [route,selector] of [['/reports','#exportReportButton'],['/delivery','#deliveryTableBody tr'],['/customers','#customerTableBody tr'],['/customer-history?id=1','#historySections table'],['/staff-accounts','#editContactNumberPhoneWarning'],['/orders','#orderTableBody tr']]) {
            await send('Page.navigate',{url:base+route});
            let found=false;
            for(let i=0;i<80;i++){found=await evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);if(found)break;await wait(100);}
            assert.ok(found,'Browser renders '+route);results.push('Browser renders '+route);
            if(route==='/delivery') {
                for(let i=0;i<80;i++){if(await evaluate(`Boolean(document.querySelector('[onclick^="editDelivery"]'))`))break;await wait(100);}
                await evaluate(`document.querySelector('[onclick^="editDelivery"]').click()`);
                for(let i=0;i<80;i++){if(await evaluate('document.getElementById("deliveryModal").style.display === "block"'))break;await wait(100);}
                assert.equal(await evaluate('document.getElementById("deliveryModal").style.display'), 'block');
                assert.equal(await evaluate('Array.from(document.getElementById("deliveryAssignee").options).some(option=>option.textContent === "Test Driver")'),true);
                await evaluate('closeDeliveryModal()');
                results.push('Delivery editor offers active drivers for assignment');
            }
            if(route==='/reports') {
                for (const endpoint of ['inventory','sales','delivery','customers','transactions','remittance']) {
                    await evaluate('loadReport('+JSON.stringify(endpoint)+')');
                    let loaded=false;
                    for(let i=0;i<80;i++){loaded=await evaluate('document.querySelectorAll("#reportSummary .report-stat").length > 0');if(loaded)break;await wait(100);}
                    assert.ok(loaded,'Report loads: '+endpoint);
                }
                const csv = await evaluate(`(async () => {
                    currentReport={config:reports.customers,rows:[{customer_id:1,customer_name:'=SUM(1,2)',address:'Quoted "value"'}]};
                    renderReport();
                    const create=URL.createObjectURL, click=HTMLAnchorElement.prototype.click;
                    let blob; URL.createObjectURL=value=>{blob=value;return create(value);};
                    HTMLAnchorElement.prototype.click=function(){};
                    try { document.getElementById('exportReportButton').click();return await blob.text(); }
                    finally { URL.createObjectURL=create;HTMLAnchorElement.prototype.click=click; }
                })()`);
                // The download is an .xlsx (a zip stored without compression, so its XML is
                // readable here): a name like "=SUM(1,2)" is kept as text, never a formula.
                assert.ok(csv.startsWith('PK') && csv.includes('<t xml:space="preserve">=SUM(1,2)</t>') && !csv.includes('<f>SUM(1,2)') && csv.includes('Quoted &quot;value&quot;'));
                results.push('All six report screens load and the Excel download keeps formulas and quotes as plain text');
            }
            if(route==='/customers') {
                assert.equal(await evaluate('document.querySelector("#customerTableBody").textContent.includes("<img src=x") && !document.querySelector("#customerTableBody img") && !window.customerMarkupExecuted'), true);
                results.push('Customer names display as text without executing HTML');
            }
            if(route==='/staff-accounts') {
                for(let i=0;i<80;i++){if(await evaluate('document.getElementById("accountRows").textContent.includes("customer@example.com")'))break;await wait(100);}
                assert.equal(await evaluate('document.getElementById("accountRows").textContent.includes("customer@example.com")'),true);
                await evaluate('manageCustomerAccount(1)');
                assert.equal(await evaluate('document.getElementById("accountEmail").value'), 'customer@example.com');
                await evaluate('document.getElementById("customerAccountDialog").close()');
                results.push('Browser displays email in account list and editor');
                const warned=await evaluate(`(() => { const field=document.getElementById('editContactNumber');field.value='09123abc789';field.dispatchEvent(new Event('input'));return !field.checkValidity() && !document.getElementById('editContactNumberPhoneWarning').hidden; })()`);
                assert.equal(warned,true);results.push('Browser phone validation rejects letters with a visible warning');
            }
        }
        await setCookie(driver);await send('Page.navigate',{url:base+'/delivery'});
        for(let i=0;i<80;i++){if(await evaluate('document.getElementById("btnAddDelivery")?.hidden && document.querySelector("[data-back]")?.hidden'))break;await wait(100);}
        // Drivers: no scheduling, no "Back to Dashboard", and Logout in the account menu.
        assert.equal(await evaluate('document.getElementById("btnAddDelivery").hidden && document.querySelector("[data-back]").hidden && Boolean(document.querySelector(".olv-user-menu-logout, [data-logout]"))'),true);
        results.push('Driver page hides scheduling controls and offers sign out');
        await setCookie(customer);await send('Page.navigate',{url:base+'/customer-portal'});
        for(let i=0;i<80;i++){if(await evaluate('Boolean(document.querySelector(".product-choice"))'))break;await wait(100);}
        assert.equal(await evaluate('document.querySelector(".product-choice").click();document.getElementById("product").value'), '1');
        assert.equal(await evaluate('document.querySelector(".product-choice").click();document.getElementById("product").value'), '');
        results.push('Browser product selection toggles on and off');
        assert.deepEqual(await evaluate('Array.from(document.getElementById("city").options).map(option=>option.value).filter(Boolean)'), ['Legazpi City','Daraga']);
        results.push('Customer address selector offers Legazpi City and Daraga');
        await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
        await wait(250);
        const shot=await send('Page.captureScreenshot',{format:'png'});
        fs.writeFileSync(path.join(folder,'customer-portal-mobile.png'),Buffer.from(shot.data,'base64'));
        console.log('Browser smoke checks passed; mobile screenshot:',path.join(folder,'customer-portal-mobile.png'));
    } finally {ws?.close();child.kill();}
}
main().catch(error=>{console.error(error);console.error(output);process.exitCode=1;}).finally(()=>{server?.kill();if(db)db.close();});
