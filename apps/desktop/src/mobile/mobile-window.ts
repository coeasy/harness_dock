import { BrowserWindow } from 'electron'
import { localeOf } from '../i18n.ts'
import { mobilePreloadPath } from '../paths.ts'

let mobileWindow: BrowserWindow | undefined

interface MobileLabels {
  title: string
  subtitle: string
  gateway: string
  gatewayDisabled: string
  gatewayHint: string
  publicUrl: string
  createPairing: string
  refresh: string
  revokeAll: string
  pairingCode: string
  expires: string
  copy: string
  copied: string
  devices: string
  noDevices: string
  revoke: string
  paired: string
  lastSeen: string
  sessionExpires: string
  confirmRevokeAll: string
  error: string
}

function labels(): MobileLabels {
  const zh = localeOf(undefined) === 'zh-CN'
  if (zh) {
    return {
      title: 'HarnessDock 移动设备',
      subtitle: 'Perry iOS / Android Remote Runtime Preview',
      gateway: '远程 Gateway',
      gatewayDisabled: 'Gateway 当前未启用。',
      gatewayHint:
        'Preview 需要显式启用 HARNESSDOCK_GATEWAY_ENABLE=1，并配置可信 HTTPS 的 HARNESSDOCK_GATEWAY_PUBLIC_URL。Gateway 默认只监听本机回环地址。',
      publicUrl: '公开 HTTPS 地址',
      createPairing: '生成一次性配对码',
      refresh: '刷新',
      revokeAll: '撤销全部设备',
      pairingCode: '配对码',
      expires: '失效时间',
      copy: '复制',
      copied: '已复制',
      devices: '当前移动设备会话',
      noDevices: '暂无已连接的移动设备。',
      revoke: '撤销',
      paired: '配对',
      lastSeen: '最后活动',
      sessionExpires: '会话失效',
      confirmRevokeAll: '确定撤销全部移动设备会话？',
      error: '操作失败',
    }
  }
  return {
    title: 'HarnessDock Mobile Devices',
    subtitle: 'Perry iOS / Android Remote Runtime Preview',
    gateway: 'Remote Gateway',
    gatewayDisabled: 'The Gateway is not enabled.',
    gatewayHint:
      'Preview requires HARNESSDOCK_GATEWAY_ENABLE=1 and a trusted HTTPS HARNESSDOCK_GATEWAY_PUBLIC_URL. The Gateway binds to loopback by default.',
    publicUrl: 'Public HTTPS URL',
    createPairing: 'Create one-time pairing code',
    refresh: 'Refresh',
    revokeAll: 'Revoke all devices',
    pairingCode: 'Pairing code',
    expires: 'Expires',
    copy: 'Copy',
    copied: 'Copied',
    devices: 'Active mobile device sessions',
    noDevices: 'No mobile devices are connected.',
    revoke: 'Revoke',
    paired: 'Paired',
    lastSeen: 'Last seen',
    sessionExpires: 'Session expires',
    confirmRevokeAll: 'Revoke every mobile device session?',
    error: 'Operation failed',
  }
}

export function openMobileManagerWindow(): void {
  if (mobileWindow && !mobileWindow.isDestroyed()) {
    if (!mobileWindow.isVisible()) mobileWindow.show()
    mobileWindow.focus()
    void mobileWindow.webContents.executeJavaScript('window.__harnessDockMobileRefresh?.()').catch(() => undefined)
    return
  }

  mobileWindow = new BrowserWindow({
    width: 700,
    height: 620,
    minWidth: 600,
    minHeight: 520,
    title: 'HarnessDock Mobile',
    backgroundColor: '#0b1120',
    show: false,
    webPreferences: {
      preload: mobilePreloadPath,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  mobileWindow.on('closed', () => {
    mobileWindow = undefined
  })
  const html = renderMobileHtml(labels())
  void mobileWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  mobileWindow.once('ready-to-show', () => mobileWindow?.show())
}

function renderMobileHtml(l: MobileLabels): string {
  const labelsJson = JSON.stringify(l).replace(/</g, '\\u003c')
  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
*{box-sizing:border-box}html,body{margin:0;min-height:100%;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",system-ui,sans-serif;background:#0b1120;color:#c7d2e3;font-size:13px}
body{padding:20px}.header{margin-bottom:16px}.title{font-size:19px;font-weight:700;color:#f4f7fb}.sub{margin-top:4px;color:#7f8fa9;font-size:12px}
.card{background:#111b2b;border:1px solid #263449;border-radius:12px;padding:14px;margin-bottom:14px}.row{display:flex;align-items:center;gap:9px;flex-wrap:wrap}.between{justify-content:space-between}.label{color:#8091ad;font-size:11px;text-transform:uppercase;letter-spacing:.05em}.value{color:#eef2fa;word-break:break-all;margin-top:5px}.hint{color:#8da0bc;line-height:1.55;margin-top:9px}
.btn{appearance:none;border:1px solid #33445d;background:#172338;color:#d7e0ee;border-radius:8px;padding:7px 11px;cursor:pointer}.btn:hover{background:#20304a}.btn.primary{background:#14b8a6;border-color:#14b8a6;color:#05231f;font-weight:700}.btn.danger{border-color:#7f3440;color:#ffb6bf;background:#27171d}.btn:disabled{opacity:.45;cursor:default}
.code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:28px;letter-spacing:.12em;color:#6ee7d8;margin:9px 0 3px}.muted{color:#73839c;font-size:11px}.result{min-height:18px;color:#6ee7d8;margin:8px 0}.devices{display:flex;flex-direction:column;gap:8px;margin-top:10px}.device{border:1px solid #263449;background:#0d1625;border-radius:10px;padding:10px;display:grid;grid-template-columns:1fr auto;gap:8px}.device-name{font-weight:650;color:#eef2fa}.meta{color:#7f8fa9;font-size:11px;line-height:1.55;margin-top:4px}.empty{padding:12px 0;color:#71819a}
</style></head><body>
<div class="header"><div class="title">${l.title}</div><div class="sub">${l.subtitle}</div></div>
<div class="card"><div class="row between"><div><div class="label">${l.gateway}</div><div id="gateway-state" class="value">—</div></div><button id="refresh" class="btn">${l.refresh}</button></div><div id="gateway-hint" class="hint"></div></div>
<div class="card"><div class="row between"><div class="label">${l.pairingCode}</div><button id="create" class="btn primary">${l.createPairing}</button></div><div id="pairing" class="empty">—</div></div>
<div class="card"><div class="row between"><div class="label">${l.devices}</div><button id="revoke-all" class="btn danger">${l.revokeAll}</button></div><div id="devices" class="devices"></div></div>
<div id="result" class="result"></div>
<script>
window.__L=${labelsJson};
(function(){
'use strict';
var L=window.__L,api=window.harnessDockMobile;
function $(id){return document.getElementById(id)}
function text(id,value){var e=$(id);if(e)e.textContent=value}
function fmtTime(value){try{return new Date(value).toLocaleString()}catch(_){return String(value||'')}}
function setResult(value,bad){var e=$('result');if(!e)return;e.textContent=value||'';e.style.color=bad?'#ff9aa7':'#6ee7d8'}
async function refresh(){
  try{
    var s=await api.getStatus();
    var enabled=!!s.enabled;
    text('gateway-state',enabled?((L.publicUrl+': ')+(s.publicUrl||'-')):L.gatewayDisabled);
    text('gateway-hint',enabled?'':L.gatewayHint);
    $('create').disabled=!enabled;
    var devices=Array.isArray(s.devices)?s.devices:[];
    $('revoke-all').disabled=!enabled||devices.length===0;
    renderDevices(devices);
  }catch(e){setResult(L.error+': '+String(e),true)}
}
function renderDevices(devices){
  var root=$('devices');root.textContent='';
  if(!devices.length){var empty=document.createElement('div');empty.className='empty';empty.textContent=L.noDevices;root.appendChild(empty);return}
  devices.forEach(function(d){
    var row=document.createElement('div');row.className='device';
    var left=document.createElement('div');var name=document.createElement('div');name.className='device-name';name.textContent=d.name||d.id;left.appendChild(name);
    var meta=document.createElement('div');meta.className='meta';meta.textContent=L.paired+': '+fmtTime(d.pairedAt)+' · '+L.lastSeen+': '+fmtTime(d.lastSeenAt)+' · '+L.sessionExpires+': '+fmtTime(d.sessionExpiresAt);left.appendChild(meta);row.appendChild(left);
    var button=document.createElement('button');button.className='btn danger';button.textContent=L.revoke;button.addEventListener('click',async function(){await api.revokeDevice(d.id);await refresh()});row.appendChild(button);root.appendChild(row)
  })
}
$('refresh').addEventListener('click',refresh);
$('create').addEventListener('click',async function(){
  try{
    var r=await api.createPairing();if(!r||!r.ok){setResult(L.error+': '+String(r&&r.error||'unknown'),true);return}
    var box=$('pairing');box.textContent='';var code=document.createElement('div');code.className='code';code.textContent=r.ticket.code;box.appendChild(code);
    var meta=document.createElement('div');meta.className='muted';meta.textContent=L.expires+': '+fmtTime(r.ticket.expiresAt);box.appendChild(meta);
    var copy=document.createElement('button');copy.className='btn';copy.style.marginTop='8px';copy.textContent=L.copy;copy.addEventListener('click',async function(){await api.copyText(r.ticket.code);copy.textContent=L.copied});box.appendChild(copy);
  }catch(e){setResult(L.error+': '+String(e),true)}
});
$('revoke-all').addEventListener('click',async function(){if(!confirm(L.confirmRevokeAll))return;await api.revokeAll();await refresh()});
window.__harnessDockMobileRefresh=refresh;void refresh();
})();
</script></body></html>`
}
