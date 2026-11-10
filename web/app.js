'use strict';
const $ = id => document.getElementById(id);
const DURATION = 8000;
const STREAMS = 6;
let running = false, token = '', controller, samples = [], result = {}, history = [], endpoint = '路由器';
try { const saved = JSON.parse(localStorage.getItem('w-lan-speed-history') || '[]'); if (Array.isArray(saved)) history = saved.filter(r => Number.isFinite(r.time) && ['download','upload','latency','jitter'].every(k => Number.isFinite(r[k]))).slice(0,10); } catch {}
function renderHistory() {
  $('history').replaceChildren();
  for (const item of history) {
    const row = document.createElement('tr');
    for (const text of [new Date(item.time).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}), ...['download','upload','latency','jitter'].map(k => item[k].toFixed(1))]) {
      const cell = document.createElement('td'); cell.textContent = text; row.append(cell);
    }
    $('history').append(row);
  }
  $('empty').hidden = history.length > 0;
  $('clear').disabled = !history.length || running;
}
function saveHistory() { try { localStorage.setItem('w-lan-speed-history', JSON.stringify(history)); } catch {} renderHistory(); }
$('clear').onclick = () => { history = []; saveHistory(); };
async function request(path, options = {}) {
  const response = await fetch('/api/' + path, {cache:'no-store', ...options, headers:{'X-Speedtest-Token':token, ...options.headers}});
  if (!response.ok) throw new Error((await response.text()).trim() || '设备没有响应，请重试。');
  return response;
}
function graph(value) {
  samples.push(value);
  const max = Math.max(10, ...samples) * 1.12;
  const points = samples.map((n,i) => `${(i / Math.max(32,samples.length-1) * 1000).toFixed(1)},${(115-n/max*105).toFixed(1)}`);
  $('line').setAttribute('d', 'M' + points.join(' L'));
  $('area').setAttribute('d', `M0,125 L${points.join(' L')} L${(samples.length-1)/Math.max(32,samples.length-1)*1000},125 Z`);
}
function showSpeed(bytes, start, phase) {
  const seconds = (performance.now() - start) / 1000;
  const speed = bytes * 8 / seconds / 1e6;
  $('speed').textContent = speed.toFixed(1);
  const current = phase === 'download' ? 0 : 1;
  $('elapsed').textContent = `${Math.min(8, Math.floor(seconds))} / 8 秒`;
  $('progress').style.width = `${10 + current*44 + Math.min(1,seconds/8)*44}%`;
  return speed;
}
async function ping() {
  $('phase').textContent = '01 / 测量延迟'; $('direction').textContent = 'HTTP 往返延迟'; $('unit').textContent = 'ms';
  const times = [];
  for (let i=0; i<13; i++) {
    const start = performance.now();
    await request('ping', {signal:AbortSignal.any([controller.signal, AbortSignal.timeout(3000)])});
    const ms = performance.now() - start;
    if (i) times.push(ms); // The first request warms the connection.
    $('speed').textContent = ms.toFixed(1);
    $('progress').style.width = `${(i+1)/13*10}%`;
    await new Promise(resolve => setTimeout(resolve, 60));
  }
  const sorted = [...times].sort((a,b)=>a-b);
  result.latency = (sorted[5]+sorted[6])/2;
  result.jitter = times.slice(1).reduce((sum,n,i)=>sum+Math.abs(n-times[i]),0)/(times.length-1);
  $('latency').textContent = result.latency.toFixed(1); $('jitter').textContent = result.jitter.toFixed(1);
}
async function transfer(phase) {
  const down = phase === 'download';
  document.body.dataset.phase = phase;
  $('phase').textContent = down ? '02 / 测量下载' : '03 / 测量上传';
  $('direction').textContent = down ? `${endpoint} → 此设备` : `此设备 → ${endpoint}`;
  $('unit').textContent = 'Mbps'; samples = []; $('line').setAttribute('d',''); $('area').setAttribute('d','');
  let bytes = 0, previous = 0, lastTick = performance.now();
  const start = performance.now();
  const phaseController = new AbortController();
  const signal = AbortSignal.any([controller.signal,phaseController.signal]);
  let stopTimer;
  const chartTimer = setInterval(() => {
    const now = performance.now(); graph((bytes-previous)*8/(now-lastTick)/1000); previous=bytes; lastTick=now;
    showSpeed(bytes,start,phase);
  }, 250);
  try {
    if (down) {
      stopTimer = setTimeout(()=>phaseController.abort(), DURATION);
      await Promise.all(Array.from({length:STREAMS}, async()=>{
        try {
          const response = await request('download',{signal});
          const reader = response.body.getReader();
          while (true) { const {done,value} = await reader.read(); if(done) break; bytes += value.byteLength; }
        } catch (e) { if (!phaseController.signal.aborted || controller.signal.aborted) throw e; }
      }));
    } else {
      // Adaptive requests aim at 250 ms; count only bytes acknowledged by the server.
      const payload = new Uint8Array(8*1024*1024);
      for(let i=0;i<payload.length;i+=65536) crypto.getRandomValues(payload.subarray(i,i+65536));
      await Promise.all(Array.from({length:STREAMS},async()=>{
        let size = 256*1024;
        while (performance.now()-start < DURATION) {
          const sent = performance.now();
          const response = await request('upload',{method:'POST',body:payload.subarray(0,size),signal:AbortSignal.any([signal,AbortSignal.timeout(5000)]),headers:{'Content-Type':'application/octet-stream'}});
          const ack = await response.json();
          if (ack.bytes !== size) throw new Error('上传确认字节数不一致，请重试。');
          bytes += ack.bytes;
          size = Math.min(payload.length,Math.max(16384,Math.round(size*250/Math.max(1,performance.now()-sent))));
        }
      }));
    }
    controller.signal.throwIfAborted();
    if (!bytes) throw new Error('没有收到测速数据，请检查网络后重试。');
    result[phase] = showSpeed(bytes,start,phase);
    $(phase).textContent = result[phase].toFixed(1);
  } finally { clearTimeout(stopTimer); clearInterval(chartTimer); phaseController.abort(); }
}
function cancel(reason) { if(running) controller.abort(new Error(reason)); }
document.addEventListener('visibilitychange',()=>{if(document.hidden) cancel('页面已切到后台，测速已停止。请保持页面在前台后重新开始。');});
$('start').onclick = async () => {
  if (running) { cancel('测速已停止，可以重新开始。'); return; }
  running = true; controller = new AbortController(); result = {}; token = '';
  $('start').textContent = '停止测速'; $('clear').disabled=true;
  $('hint').textContent = '6 路并发传输中。请暂停其他下载，并保持页面在前台。';
  for(const id of ['download','upload','latency','jitter']) $(id).textContent='—';
  try {
    token = (await (await request('session',{method:'POST',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(5000)])})).json()).token;
    await ping(); await transfer('download'); await transfer('upload');
    $('phase').textContent='测速完成'; $('elapsed').textContent='本次测试已完成'; $('progress').style.width='100%';
    $('hint').textContent='结果已保存。换个位置、靠近路由器，或接上网线再比较一下。';
    history.unshift({...result,time:Date.now()}); history=history.slice(0,10); saveHistory();
  } catch(e) {
    controller.abort(e);
    $('phase').textContent='测速未完成'; $('direction').textContent='请重新开始';
    $('hint').textContent=e.message || '网络连接中断，请检查连接后重试。';
    $('elapsed').textContent='未保存本次结果';
  } finally {
    if(token) { try { await request('session',{method:'DELETE',signal:AbortSignal.timeout(3000)}); } catch {} }
    token=''; running=false; $('start').innerHTML='再测一次 <span>↗</span>'; renderHistory();
  }
};
request('info',{signal:AbortSignal.timeout(5000)}).then(r=>r.json()).then(info=>{
  $('connection').textContent='设备已连接'; document.querySelector('.connection').classList.add('ready');
  $('router').textContent=info.hostname; $('router').title=location.host;
  if (info.wired_peer) {
    endpoint='有线对端';
    $('router').textContent='路由器 → 有线测速对端';
    $('download-path').textContent='Mbps · 有线对端 → 此设备';
    $('upload-path').textContent='Mbps · 此设备 → 有线对端';
    document.querySelector('.description').textContent='经 Wi-Fi 与路由器，到万兆有线主机。测量这条链路的实际传输表现。';
    $('hint').textContent='当前测量 Wi-Fi 到有线主机的转发速度，数据不经过互联网。';
  }
  if (info.peer_url) {
    const peer = new URL(info.peer_url);
    if (peer.protocol === 'http:' && !peer.username && !peer.password) {
      $('peer-link').href=peer.href; $('peer-link').hidden=false;
    }
  }
}).catch(()=>{$('connection').textContent='设备连接失败'; $('hint').textContent='无法连接测速服务。请确认处于同一局域网，然后刷新页面。';});
renderHistory();
